(function () {
	const DEFAULT_LBP_PER_USD = 89500;

	const transactionTables = {
		"Sales Invoice": ["items"],
		"Purchase Invoice": ["items"],
		"Payment Entry": ["references"],
		"Journal Entry": ["accounts"],
	};

	function getRate(frm) {
		return flt(frm.doc.custom_exchange_rate_override) || DEFAULT_LBP_PER_USD;
	}

	function recalculateStampTaxes(frm) {
		if (frm.doctype !== "Sales Invoice" && frm.doctype !== "Purchase Invoice") return;
		const taxes = frm.doc.taxes || [];
		const currency = frm.doc.currency || "USD";
		const rate = getRate(frm);
		let changed = false;

		taxes.forEach(tax => {
			if (!tax.custom_is_stamp || !flt(tax.custom_stamp_amount_lbp)) return;
			const lbpAmount = flt(tax.custom_stamp_amount_lbp);
			const taxAmount = currency === "LBP" ? lbpAmount : flt(lbpAmount / rate);

			if (tax.charge_type !== "Actual" || flt(tax.rate) !== 0 ||
				Math.abs(flt(tax.tax_amount) - taxAmount) > 0.001) {
				frappe.model.set_value(tax.doctype, tax.name, "charge_type", "Actual");
				frappe.model.set_value(tax.doctype, tax.name, "rate", 0);
				frappe.model.set_value(tax.doctype, tax.name, "tax_amount", taxAmount);
				changed = true;
			}
		});

		if (changed) frm.refresh_field("taxes");
	}

	function getCurrency(frm) {
		return frm.doc.currency || frm.doc.paid_from_account_currency || "USD";
	}

	function getLineAmount(row) {
		const fields = [
			"amount",
			"allocated_amount",
			"debit_in_account_currency",
			"credit_in_account_currency",
			"debit",
			"credit",
		];
		for (const field of fields) {
			const value = Math.abs(flt(row[field]));
			if (value) return value;
		}
		return 0;
	}

	function setDualCurrencyValues(frm, row) {
		if (!row) return;
		const amount = getLineAmount(row);
		const rate = getRate(frm);
		const currency = row.account_currency || getCurrency(frm);
		const usdAmount = currency === "LBP" ? amount / rate : amount;
		const lbpAmount = currency === "LBP" ? amount : amount * rate;

		frappe.model.set_value(row.doctype, row.name, "custom_usd_amount", usdAmount);
		frappe.model.set_value(row.doctype, row.name, "custom_lbp_amount", Math.round(lbpAmount));
	}

	function refreshDualCurrency(frm) {
		(transactionTables[frm.doctype] || []).forEach((tableField) => {
			(frm.doc[tableField] || []).forEach((row) => setDualCurrencyValues(frm, row));
			frm.refresh_field(tableField);
		});
	}

	function syncPaymentEntryAmounts(frm) {
		if (frm.doctype !== "Payment Entry" || frm.doc.payment_type === "Internal Transfer") return;

		const total = (frm.doc.references || []).reduce((sum, row) => sum + flt(row.allocated_amount), 0);
		if (total <= 0) return;

		frm.set_value("paid_amount", total);
		frm.set_value("received_amount", total);
		frm.set_value("total_allocated_amount", total);
	}

	function attachEnterToAddRows(frm) {
		(transactionTables[frm.doctype] || []).forEach((tableField) => {
			const grid = frm.fields_dict[tableField] && frm.fields_dict[tableField].grid;
			if (!grid || !grid.wrapper) return;

			grid.wrapper.off("keydown.sultan_enter_add_row");
			grid.wrapper.on("keydown.sultan_enter_add_row", "input, textarea, select", function (event) {
				if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
					return;
				}

				const rowName = $(event.target).closest(".grid-row").attr("data-name");
				const rows = frm.doc[tableField] || [];
				if (!rowName || !rows.length || rows[rows.length - 1].name !== rowName) return;

				event.preventDefault();
				grid.add_new_row();
			});
		});
	}

	function setupTransactionForm(doctype) {
		frappe.ui.form.on(doctype, {
			refresh(frm) {
				if (!frm.doc.custom_exchange_rate_override) {
					frm.set_value("custom_exchange_rate_override", DEFAULT_LBP_PER_USD);
				}
				attachEnterToAddRows(frm);
				refreshDualCurrency(frm);
				recalculateStampTaxes(frm);
			},
			custom_exchange_rate_override(frm) {
				refreshDualCurrency(frm);
				recalculateStampTaxes(frm);
			},
			currency(frm) {
				refreshDualCurrency(frm);
				recalculateStampTaxes(frm);
			},
			paid_from_account_currency: refreshDualCurrency,
			validate(frm) {
				refreshDualCurrency(frm);
				recalculateStampTaxes(frm);
				syncPaymentEntryAmounts(frm);
			},
		});
	}

	["Sales Invoice", "Purchase Invoice", "Payment Entry", "Journal Entry"].forEach(setupTransactionForm);

	frappe.ui.form.on("Purchase Invoice", {
		bill_no(frm) {
			if (frm.doc.bill_no && !frm.doc.custom_supplier_invoice_number) {
				frm.set_value("custom_supplier_invoice_number", frm.doc.bill_no);
			}
		},
		custom_supplier_invoice_number(frm) {
			if (frm.doc.custom_supplier_invoice_number && !frm.doc.bill_no) {
				frm.set_value("bill_no", frm.doc.custom_supplier_invoice_number);
			}
		},
	});

	frappe.ui.form.on("Sales Invoice Item", {
		qty: setRowDualCurrency,
		rate: setRowDualCurrency,
		amount: setRowDualCurrency,
	});

	frappe.ui.form.on("Purchase Invoice Item", {
		qty: setRowDualCurrency,
		rate: setRowDualCurrency,
		amount: setRowDualCurrency,
	});

	frappe.ui.form.on("Payment Entry Reference", {
		allocated_amount(frm, cdt, cdn) {
			setRowDualCurrency(frm, cdt, cdn);
			syncPaymentEntryAmounts(frm);
		},
	});

	frappe.ui.form.on("Journal Entry Account", {
		debit_in_account_currency: setRowDualCurrency,
		credit_in_account_currency: setRowDualCurrency,
		debit: setRowDualCurrency,
		credit: setRowDualCurrency,
	});

	function setRowDualCurrency(frm, cdt, cdn) {
		setDualCurrencyValues(frm, locals[cdt][cdn]);
	}
	// Stamp tax — child table events
	["Sales Taxes and Charges", "Purchase Taxes and Charges"].forEach(childDt => {
		frappe.ui.form.on(childDt, {
			custom_is_stamp(frm) { recalculateStampTaxes(frm); },
			custom_stamp_amount_lbp(frm) { recalculateStampTaxes(frm); },
		});
	});

})();
