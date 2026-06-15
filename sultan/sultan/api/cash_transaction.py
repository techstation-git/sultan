"""
Cash I/O bridge for the Sultan SPA.

Creates Sultan POS Cash Transaction documents (CASH-IO-XXXX series) with an
accompanying Journal Entry for proper GL recording.
"""
import frappe
from frappe import _
from frappe.utils import flt, nowdate, nowtime

from sultan.sultan.api.sales_invoice import get_current_pos_opening_entry

_SYNTHETIC_PROFILE = "System Default"


@frappe.whitelist()
def get_cash_io_config(pos_profile=None):
    """Return whether the Cash I/O feature is enabled for the given POS profile.

    "System Default" is a synthetic sentinel returned by get_pos_details when no
    real POS profile is resolved (e.g. stale localStorage cache). Treat it the same
    as an absent profile and resolve from the user's active opening entry instead.
    """
    if not pos_profile or pos_profile == _SYNTHETIC_PROFILE:
        opening_entry = get_current_pos_opening_entry()
        if opening_entry:
            pos_profile = frappe.db.get_value("POS Opening Entry", opening_entry, "pos_profile")

    if not pos_profile or pos_profile == _SYNTHETIC_PROFILE:
        return {"installed": True, "enabled": False, "allowed_modes": []}

    allowed_modes = frappe.get_all(
        "POS Payment Method",
        filters={"parent": pos_profile, "allowed_for_cash_in_out": 1},
        pluck="mode_of_payment",
    )

    return {
        "installed": True,
        "enabled": len(allowed_modes) > 0,
        "allowed_modes": allowed_modes,
    }


@frappe.whitelist()
def create_cash_transaction(transaction_type, amount, description="",
                            mode_of_payment=None, pos_session=None):
    """Create a Sultan POS Cash Transaction with a linked Journal Entry."""
    try:
        if not pos_session:
            pos_session = get_current_pos_opening_entry()
        if not pos_session:
            return {"success": False, "error": "No open POS session found."}
        if not mode_of_payment:
            return {"success": False, "error": "Mode of payment is required."}

        name = _create_sultan_cash_transaction(
            pos_session=pos_session,
            amount=flt(amount),
            mode_of_payment=mode_of_payment,
            description=description,
            transaction_type=transaction_type,
        )
        return {"success": True, "name": name, "message": f"{transaction_type} of {amount} recorded."}
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Create Cash Transaction Error")
        return {"success": False, "error": str(e)}


def _create_sultan_cash_transaction(pos_session, amount, mode_of_payment,
                                    description, transaction_type, employee=None):
    """Insert and submit a Sultan POS Cash Transaction + Journal Entry.

    This is the single authoritative function for all 4 transaction types
    (Cash In, Cash Out, Opening Difference, Closing Difference). All records
    land in Sultan POS Cash Transaction (CASH-IO-XXXX).
    """
    company = frappe.db.get_value("POS Opening Entry", pos_session, "company")
    pos_profile = frappe.db.get_value("POS Opening Entry", pos_session, "pos_profile")
    currency = frappe.get_cached_value("Company", company, "default_currency")

    # Cash account — from the mode of payment
    cash_account = frappe.db.get_value(
        "Mode of Payment Account",
        {"parent": mode_of_payment, "company": company},
        "default_account",
    )
    if not cash_account:
        frappe.throw(_(
            "No account configured for Mode of Payment '{0}' in company '{1}'. "
            "Go to Mode of Payment → {0} and add an account row for company {1}."
        ).format(mode_of_payment, company))

    # Offset account — POS Profile write-off account, or company write-off account
    offset_account = (
        frappe.db.get_value("POS Profile", pos_profile, "write_off_account")
        or frappe.get_cached_value("Company", company, "write_off_account")
    )
    if not offset_account:
        frappe.throw(_(
            "Please configure 'Write Off Account' in POS Profile '{0}' or Company '{1}'."
        ).format(pos_profile, company))

    now_date = nowdate()
    now_time = nowtime()

    # Cash In  → debit cash account (money enters drawer), credit offset
    # Cash Out → debit offset (expense recorded), credit cash account (money leaves drawer)
    if transaction_type in ("Cash In", "Opening Difference"):
        account_debit = cash_account
        account_credit = offset_account
    else:
        account_debit = offset_account
        account_credit = cash_account

    # 1. Create and submit Journal Entry for GL recording
    je = frappe.new_doc("Journal Entry")
    je.voucher_type = "Cash Entry"
    je.company = company
    je.posting_date = now_date
    je.user_remark = description or transaction_type
    je.append("accounts", {
        "account": account_debit,
        "debit_in_account_currency": flt(amount),
        "credit_in_account_currency": 0.0,
    })
    je.append("accounts", {
        "account": account_credit,
        "debit_in_account_currency": 0.0,
        "credit_in_account_currency": flt(amount),
    })
    je.flags.ignore_permissions = True
    je.insert(ignore_permissions=True)
    je.submit()

    # 2. Create and submit Sultan POS Cash Transaction linked to the JE
    doc = frappe.new_doc("Sultan POS Cash Transaction")
    doc.transaction_type = transaction_type
    doc.amount = flt(amount)
    doc.description = description
    doc.pos_opening_entry = pos_session
    doc.pos_profile = pos_profile
    doc.posting_date = now_date
    doc.posting_time = now_time
    doc.account_debit = account_debit
    doc.account_credit = account_credit
    doc.currency = currency
    doc.linked_journal_entry = je.name
    if employee:
        doc.cashier_employee = employee

    if mode_of_payment:
        doc.mode_of_payment = mode_of_payment
    doc.flags.ignore_permissions = True
    doc.insert(ignore_permissions=True)
    doc.submit()
    frappe.db.commit()
    return doc.name


@frappe.whitelist()
def get_cash_transactions(opening_entry=None):
    """Return Cash In/Out records for the current session."""
    if not opening_entry:
        opening_entry = get_current_pos_opening_entry()
    if not opening_entry:
        return {"success": True, "data": [], "summary": {"cash_in": 0, "cash_out": 0, "net": 0}}

    rows = frappe.get_all(
        "Sultan POS Cash Transaction",
        filters={
            "pos_opening_entry": opening_entry,
            "transaction_type": ["in", ["Cash In", "Cash Out"]],
            "docstatus": 1,
        },
        fields=[
            "name", "transaction_type", "amount",
            "description", "mode_of_payment", "posting_date", "posting_time",
        ],
        order_by="posting_date asc, posting_time asc",
    )

    data = []
    for r in rows:
        data.append({
            "name": r.name,
            "transaction_type": r.transaction_type,
            "amount": abs(flt(r.amount)),
            "description": r.description or "",
            "mode_of_payment": r.mode_of_payment or "",
            "posting_date": str(r.posting_date) if r.posting_date else "",
            "posting_time": str(r.posting_time) if r.posting_time else "",
        })

    cash_in = sum(d["amount"] for d in data if d["transaction_type"] == "Cash In")
    cash_out = sum(d["amount"] for d in data if d["transaction_type"] == "Cash Out")

    return {
        "success": True,
        "data": data,
        "summary": {"cash_in": cash_in, "cash_out": cash_out, "net": cash_in - cash_out},
    }


def create_gl_entries_for_session(opening_entry, company):
    pass
