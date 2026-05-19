// Zod input schemas for every MCP tool.
//
// One schema per tool, keyed by tool name. These are the single source of
// truth for tool input: index.ts hands each to registerTool, and the SDK
// (a) generates the advertised JSON Schema from it and (b) validates every
// incoming call against it before the handler runs.
//
// Every schema is a z.strictObject — unknown keys are rejected rather than
// silently dropped. Per-field `.describe()` text becomes the field
// description the model sees. Tools that take no input (get_current_user,
// list_bank_accounts, get_staging_directory, get_mileage_settings) have no
// entry here and are registered without an inputSchema.

import { z } from 'zod';

// A numeric resource id, as a string — replaces the old validateId guard.
const idArg = (resource: string) =>
    z.string().regex(/^\d+$/, 'must be a numeric id').describe(`${resource} ID`);

// ---- shared sub-schemas -----------------------------------------------------

const receiptAttachment = z.strictObject({
    evidence_path: z.string().describe('Absolute path to the receipt file inside the session staging directory — call get_staging_directory, then copy the file there yourself.'),
    file_name: z.string().describe('File name for the attachment'),
    content_type: z.string().describe('MIME type, e.g. image/jpeg, image/png, application/pdf'),
    description: z.string().optional().describe('Optional attachment description'),
});

const timeslipFields = {
    task: z.string().describe('Task URL'),
    user: z.string().describe('User URL'),
    project: z.string().describe('Project URL'),
    dated_on: z.string().describe('Date (YYYY-MM-DD)'),
    hours: z.string().describe('Hours worked (e.g. "1.5")'),
    comment: z.string().optional().describe('Optional comment'),
};

const invoiceItemCreate = z.strictObject({
    item_type: z.string().describe('Item type (e.g. "Days", "Hours")'),
    description: z.string().describe('Line item description'),
    quantity: z.string().describe('Quantity'),
    price: z.string().describe('Unit price'),
    sales_tax_rate: z.string().optional().describe('Sales tax rate (e.g. "20.0")'),
});

const invoiceItemUpdate = z.strictObject({
    id: z.string().optional().describe('Invoice item ID (from URL) — required to update an existing item'),
    position: z.number().optional().describe('Line item position (starting at 1)'),
    item_type: z.string().describe('Item type (e.g. "Days", "Hours")'),
    description: z.string().describe('Line item description/details'),
    quantity: z.string().describe('Quantity'),
    price: z.string().describe('Unit price'),
    sales_tax_rate: z.string().optional().describe('Sales tax rate (e.g. "20.0")'),
    _destroy: z.number().optional().describe('Set to 1 to delete this line item'),
});

const INVOICE_EC_STATUS = ['UK Non-EC', 'EC VAT Registered', 'EC VAT Moss', 'EC Non-VAT Registered', 'Non-EC'] as const;
const INCLUDE_TIMESLIPS = ['billed_grouped_by_timeslip', 'billed_grouped_by_single_timeslip', 'billed_grouped_by_timeslip_task', 'billed_grouped_by_timeslip_date'] as const;
const EXPENSE_EC_STATUS = ['UK/Non-EC', 'EC Goods', 'EC Services', 'Reverse Charge'] as const;
const SALES_TAX_STATUS = ['TAXABLE', 'EXEMPT', 'OUT_OF_SCOPE'] as const;
const REBILL_TYPE = ['cost', 'markup', 'price'] as const;
const RECURRING = ['Weekly', 'Two Weekly', 'Four Weekly', 'Two Monthly', 'Quarterly', 'Biannually', 'Annually', '2-Yearly'] as const;
const VEHICLE_TYPE = ['Car', 'Motorcycle', 'Bicycle'] as const;

// Shared by create_expense and (as the array element) create_expenses.
const createExpense = z.strictObject({
    category: z.string().describe('Expense category — a name (e.g. "Travel"), a nominal code, or a category URL. Resolved against list_categories.'),
    dated_on: z.string().describe('Date the expense was incurred (YYYY-MM-DD)'),
    gross_value: z.number().positive().describe('Total amount including tax, as a POSITIVE number. Out-of-pocket by default — see refund_due.'),
    refund_due: z.boolean().optional().describe('Set true when this is money the claimant owes back to the company rather than money they paid out of pocket. Default false.'),
    user: z.string().optional().describe('Claimant — a name, email address, user URL, or "me". Defaults to the authenticated user.'),
    description: z.string().optional().describe('Free-text description of the expense'),
    receipt_reference: z.string().optional().describe('Receipt reference identifier'),
    sales_tax_rate: z.string().optional().describe('VAT rate as a percentage, e.g. "20.0". For a fixed VAT amount that is not a clean percentage of gross, use manual_sales_tax_amount instead.'),
    sales_tax_status: z.enum(SALES_TAX_STATUS).optional().describe('VAT treatment'),
    ec_status: z.enum(EXPENSE_EC_STATUS).optional().describe('EC VAT status. EC Goods / EC Services are invalid for dates on or after 2021-01-01 in Great Britain.'),
    currency: z.string().optional().describe('Currency code if the expense was in a foreign currency, e.g. "USD". FreeAgent auto-converts to your native currency.'),
    native_gross_value: z.number().positive().optional().describe('Foreign-currency expense only: the amount in your native currency, as a POSITIVE number. Omit to let FreeAgent convert automatically.'),
    manual_sales_tax_amount: z.string().optional().describe('Exact VAT amount in native currency — use when VAT is not a simple percentage of gross (e.g. only part of the cost is VATable, as on marketplace/eBay invoices). Works on any expense, domestic included. Overrides sales_tax_rate; must not exceed the gross value.'),
    project: z.string().optional().describe('Project to associate the expense with — a project name, numeric ID, or URL. Required in order to rebill the cost.'),
    rebill_type: z.enum(REBILL_TYPE).optional().describe('How to rebill the expense to the project: cost (at cost), markup (cost plus rebill_factor%), or price (a fixed price). Requires project.'),
    rebill_factor: z.string().optional().describe('The markup percentage (rebill_type "markup") or fixed price (rebill_type "price"). Required for those rebill types.'),
    recurring: z.enum(RECURRING).optional().describe('Make this a recurring expense at the given frequency.'),
    recurring_end_date: z.string().optional().describe('Date the recurrence stops (YYYY-MM-DD). Requires recurring.'),
    property: z.string().optional().describe('Property URL — required for UkUnincorporatedLandlord companies, ignored otherwise.'),
    attachment: receiptAttachment.optional().describe('Optional receipt. Call get_staging_directory, copy the file into that directory, and pass its path as evidence_path.'),
});

// ---- per-tool input schemas -------------------------------------------------

export const toolSchemas = {
    list_timeslips: z.strictObject({
        from_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        to_date: z.string().optional().describe('End date (YYYY-MM-DD)'),
        updated_since: z.string().optional().describe('ISO datetime'),
        view: z.enum(['all', 'unbilled', 'running']).optional().describe('Filter view type'),
        user: z.string().optional().describe('Filter by user URL'),
        task: z.string().optional().describe('Filter by task URL'),
        project: z.string().optional().describe('Filter by project URL'),
        nested: z.boolean().optional().describe('Include nested resources'),
    }),

    get_timeslip: z.strictObject({ id: idArg('Timeslip') }),

    create_timeslip: z.strictObject(timeslipFields),

    update_timeslip: z.strictObject({
        id: idArg('Timeslip'),
        task: z.string().optional().describe('Task URL'),
        user: z.string().optional().describe('User URL'),
        project: z.string().optional().describe('Project URL'),
        dated_on: z.string().optional().describe('Date (YYYY-MM-DD)'),
        hours: z.string().optional().describe('Hours worked (e.g. "1.5")'),
        comment: z.string().optional().describe('Optional comment'),
    }),

    delete_timeslip: z.strictObject({ id: idArg('Timeslip') }),
    start_timer: z.strictObject({ id: idArg('Timeslip') }),
    stop_timer: z.strictObject({ id: idArg('Timeslip') }),

    list_projects: z.strictObject({
        view: z.enum(['active', 'completed', 'cancelled', 'hidden']).optional().describe('Filter by project status'),
        sort: z.string().optional().describe('Sort order'),
        contact: z.string().optional().describe('Filter by contact URL'),
    }),

    create_project: z.strictObject({
        contact: z.string().describe('Contact URL'),
        name: z.string().describe('Project name'),
        status: z.enum(['Active', 'Completed', 'Cancelled', 'Hidden']).describe('Project status'),
        budget: z.number().describe('Budget amount (use 0 if no budget)'),
        budget_units: z.enum(['Hours', 'Days', 'Monetary']).describe('Budget units'),
        currency: z.string().describe('Currency code (e.g. "GBP", "USD")'),
        uses_project_invoice_sequence: z.boolean().describe('Use project-level invoice sequence'),
        contract_po_reference: z.string().optional().describe('Contract/PO reference'),
        hours_per_day: z.number().optional().describe('Hours per day (e.g. 7.5)'),
        normal_billing_rate: z.string().optional().describe('Normal billing rate'),
        billing_period: z.enum(['hour', 'day']).optional().describe('Billing period'),
        is_ir35: z.boolean().optional().describe('IR35 employment status'),
        starts_on: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        ends_on: z.string().optional().describe('End date (YYYY-MM-DD)'),
        include_unbilled_time_in_profitability: z.boolean().optional().describe('Include unbilled time in profitability'),
    }),

    create_task: z.strictObject({
        project: z.string().describe('Project URL'),
        name: z.string().describe('Task name'),
        is_billable: z.boolean().optional().describe('Whether the task is billable'),
        status: z.enum(['Active', 'Completed', 'Hidden']).optional().describe('Task status'),
        billing_rate: z.string().optional().describe('Billing rate'),
        billing_period: z.enum(['hour', 'day']).optional().describe('Billing period'),
    }),

    list_tasks: z.strictObject({
        project: z.string().optional().describe('Filter by project URL'),
        view: z.string().optional().describe('Filter view type'),
        sort: z.string().optional().describe('Sort order'),
    }),

    list_users: z.strictObject({
        view: z.string().optional().describe('Filter view type'),
    }),

    create_invoice: z.strictObject({
        contact: z.string().describe('Contact URL'),
        project_ids: z.array(z.string()).optional().describe('Numeric project IDs that this invoice covers. Use a single-element array for a single-project invoice; multiple entries make this a multi-project invoice. URLs are accepted in entries and converted to IDs. Order does not matter.'),
        numbering_source: z.string().optional().describe('Which project\'s invoice sequence to draw the reference number from. Set to a project ID present in project_ids to use that project\'s per-project sequence, or to "org-wide" to use the organisation-wide sequence. For single-project invoices this defaults to that project. For multi-project invoices it is required if any project on the invoice has uses_project_invoice_sequence=true.'),
        dated_on: z.string().describe('Invoice date (YYYY-MM-DD)'),
        payment_terms_in_days: z.number().optional().describe('Payment terms in days (default: 30)'),
        comments: z.string().optional().describe('Additional comments'),
        ec_status: z.enum(INVOICE_EC_STATUS).optional().describe('EC/VAT status'),
        include_timeslips: z.enum(INCLUDE_TIMESLIPS).optional().describe('How to group unbilled timeslips into invoice line items. When set, all unbilled timeslips on the implicated project(s) are attached.'),
        omit_unbilled_timeslips: z.boolean().optional().describe('Set to true to deliberately create the invoice without attaching unbilled timeslips that exist on the implicated project(s). Required when include_timeslips is omitted and unbilled timeslips exist.'),
        invoice_items: z.array(invoiceItemCreate).optional().describe('Manual line items (use instead of include_timeslips for full control over descriptions)'),
    }),

    list_invoices: z.strictObject({
        project: z.string().optional().describe('Filter by project URL'),
        contact: z.string().optional().describe('Filter by contact URL'),
        view: z.enum(['recent_open_or_overdue', 'open_or_overdue', 'draft', 'scheduled_to_email', 'thank_you_emails', 'reminders', 'overdue']).optional().describe('Filter view type'),
        sort: z.string().optional().describe('Sort order'),
        updated_since: z.string().optional().describe('Only return invoices updated after this ISO datetime (e.g. 2026-03-01T00:00:00.000Z)'),
    }),

    get_invoice: z.strictObject({ id: idArg('Invoice') }),

    update_invoice: z.strictObject({
        id: idArg('Invoice'),
        payment_terms_in_days: z.number().optional().describe('Payment terms in days'),
        comments: z.string().optional().describe('Additional comments'),
        ec_status: z.enum(INVOICE_EC_STATUS).optional().describe('EC/VAT status'),
        project_ids: z.array(z.string()).optional().describe('Numeric project IDs that this invoice should cover. Pass the full set (existing + extras); URLs accepted and converted to IDs. Order does not matter.'),
        include_timeslips: z.enum(INCLUDE_TIMESLIPS).optional().describe('When extending the invoice with project_ids, set this to attach unbilled timeslips from the newly added project(s).'),
        omit_unbilled_timeslips: z.boolean().optional().describe('When extending the invoice with project_ids, set to true to deliberately leave unbilled timeslips on the added project(s) untouched.'),
        invoice_items: z.array(invoiceItemUpdate).optional().describe('Updated line items. Include "id" to update an existing item, or omit "id" to add a new item. Set "_destroy": 1 to delete an item.'),
    }),

    download_invoice_pdf: z.strictObject({ id: idArg('Invoice') }),

    delete_invoice: z.strictObject({
        id: idArg('Invoice'),
        confirm: z.boolean().optional().describe('Required when invoice status is not Draft. Confirms intent to delete a sent/non-draft invoice.'),
    }),

    mark_invoice_as_draft: z.strictObject({ id: idArg('Invoice') }),
    mark_invoice_as_sent: z.strictObject({ id: idArg('Invoice') }),

    list_categories: z.strictObject({
        sub_accounts: z.boolean().optional().describe('Return sub-accounts instead of top-level accounts'),
    }),

    list_bank_transactions: z.strictObject({
        bank_account: z.string().describe('Bank account URL (required)'),
        from_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        to_date: z.string().optional().describe('End date (YYYY-MM-DD)'),
        updated_since: z.string().optional().describe('ISO datetime'),
        view: z.enum(['all', 'unexplained', 'explained', 'manual', 'imported', 'marked_for_review']).optional().describe('Filter view type'),
    }),

    list_bank_transaction_explanations: z.strictObject({
        bank_account: z.string().describe('Bank account URL (required)'),
        from_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        to_date: z.string().optional().describe('End date (YYYY-MM-DD)'),
        updated_since: z.string().optional().describe('ISO datetime'),
    }),

    list_bills: z.strictObject({
        from_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        to_date: z.string().optional().describe('End date (YYYY-MM-DD)'),
        updated_since: z.string().optional().describe('ISO datetime'),
        contact: z.string().optional().describe('Filter by contact/supplier URL'),
        project: z.string().optional().describe('Filter by project URL'),
        view: z.enum(['all', 'open', 'overdue', 'open_or_overdue', 'paid', 'recurring', 'hire_purchase', 'cis']).optional().describe('Filter by bill status'),
        nested_bill_items: z.boolean().optional().describe('Include bill line items in response'),
    }),

    get_bill: z.strictObject({ id: idArg('Bill') }),

    get_profit_and_loss_summary: z.strictObject({
        from_date: z.string().optional().describe('Period start date (YYYY-MM-DD). Defaults to accounting year start if omitted.'),
        to_date: z.string().optional().describe('Period end date (YYYY-MM-DD). Defaults to today if omitted.'),
        accounting_period: z.string().optional().describe('Accounting period in YYYY/YY format (e.g. "2025/26"). Alternative to from_date/to_date.'),
    }),

    create_timeslips: z.strictObject({
        timeslips: z.array(z.strictObject(timeslipFields)).min(1).describe('Array of timeslip objects to create'),
    }),

    list_expenses: z.strictObject({
        view: z.enum(['recent', 'recurring']).optional().describe('recent = recently dated expenses; recurring = recurring expense templates only.'),
        from_date: z.string().optional().describe('Inclusive start date (YYYY-MM-DD)'),
        to_date: z.string().optional().describe('Inclusive end date (YYYY-MM-DD)'),
        updated_since: z.string().optional().describe('Only expenses updated after this ISO datetime'),
        project: z.string().optional().describe('Filter by project URL (rebillable expenses)'),
        user: z.string().optional().describe('Filter by claimant — a name, email, user URL, or "me". Applied client-side after fetching.'),
    }),

    get_expense: z.strictObject({ id: idArg('Expense') }),

    create_expense: createExpense,

    update_expense: z.strictObject({
        id: idArg('Expense'),
        category: z.string().optional().describe('New category — name, nominal code, or URL'),
        dated_on: z.string().optional().describe('New date (YYYY-MM-DD)'),
        gross_value: z.number().positive().optional().describe('New total amount, as a POSITIVE number. Out-of-pocket unless refund_due is set.'),
        refund_due: z.boolean().optional().describe('Direction for gross_value when it is being changed. Default false (out-of-pocket).'),
        user: z.string().optional().describe('New claimant — a name, email, user URL, or "me"'),
        description: z.string().optional().describe('New description'),
        receipt_reference: z.string().optional().describe('New receipt reference'),
        sales_tax_rate: z.string().optional().describe('New VAT rate, e.g. "20.0". For a fixed VAT amount, use manual_sales_tax_amount instead.'),
        sales_tax_status: z.enum(SALES_TAX_STATUS).optional().describe('New VAT treatment'),
        ec_status: z.enum(EXPENSE_EC_STATUS).optional().describe('New EC VAT status'),
        currency: z.string().optional().describe('New currency code for a foreign-currency expense'),
        native_gross_value: z.number().positive().optional().describe('New native-currency amount, as a POSITIVE number (foreign-currency expense)'),
        manual_sales_tax_amount: z.string().optional().describe('Exact VAT amount in native currency — use when VAT is not a simple percentage of gross. Overrides sales_tax_rate; must not exceed the gross value.'),
        project: z.string().optional().describe('Project to associate the expense with — a project name, numeric ID, or URL'),
        rebill_type: z.enum(REBILL_TYPE).optional().describe('How to rebill the expense to the project'),
        rebill_factor: z.string().optional().describe('Markup percentage or fixed price for rebill_type markup/price'),
        recurring: z.enum(RECURRING).optional().describe('Recurrence frequency'),
        recurring_end_date: z.string().optional().describe('Date the recurrence stops (YYYY-MM-DD)'),
        property: z.string().optional().describe('Property URL (UkUnincorporatedLandlord companies)'),
        attachment: receiptAttachment.optional().describe('Replacement receipt. Call get_staging_directory, copy the file into that directory, and pass its path as evidence_path.'),
    }),

    delete_expense: z.strictObject({
        id: idArg('Expense'),
        confirm: z.boolean().optional().describe('Required when the expense has been rebilled onto an invoice.'),
    }),

    create_mileage_expense: z.strictObject({
        dated_on: z.string().describe('Date of travel (YYYY-MM-DD)'),
        mileage: z.number().positive().describe('Miles travelled, as a positive number'),
        vehicle_type: z.enum(VEHICLE_TYPE).describe('Vehicle used for the journey'),
        engine_type: z.string().optional().describe('Engine type for a Car/Motorcycle, e.g. "Petrol", "Diesel", "Electric". Defaults to Petrol. Validated against get_mileage_settings.'),
        engine_size: z.string().optional().describe('Engine size band for a Car/Motorcycle, e.g. "Up to 1400cc". Validated against get_mileage_settings.'),
        reclaim_mileage: z.boolean().optional().describe('Whether to reclaim at the HMRC AMAP rate. Default true.'),
        user: z.string().optional().describe('Claimant — a name, email address, user URL, or "me". Defaults to the authenticated user.'),
        description: z.string().optional().describe('Free-text description of the journey'),
        receipt_reference: z.string().optional().describe('Receipt reference identifier'),
        have_vat_receipt: z.boolean().optional().describe('Whether a VAT receipt is held for the fuel'),
        attachment: receiptAttachment.optional().describe('Optional supporting document. Call get_staging_directory, copy the file into that directory, and pass its path as evidence_path.'),
    }),

    create_expenses: z.strictObject({
        expenses: z.array(createExpense).min(1).max(100).describe('Up to 100 expense objects, each shaped like the create_expense arguments.'),
    }),
};

export type ToolName = keyof typeof toolSchemas;
