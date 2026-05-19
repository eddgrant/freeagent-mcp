export interface TimeslipAttributes {
    url?: string;
    task: string;
    user: string;
    project: string;
    dated_on: string;
    hours: string;
    comment?: string;
    billed_on_invoice?: string;
    created_at?: string;
    updated_at?: string;
    timer?: TimerAttributes;
}

export interface TimerAttributes {
    running: boolean;
    start_from: string;
}

export interface Timeslip {
    url: string;
    task: string;
    user: string;
    project: string;
    dated_on: string;
    hours: string;
    comment?: string;
    billed_on_invoice?: string;
    created_at: string;
    updated_at: string;
    timer?: TimerAttributes;
}

export interface TimeslipsResponse {
    timeslips: Timeslip[];
}

export interface TimeslipResponse {
    timeslip: Timeslip;
}

export interface ProjectAttributes {
    contact: string;
    name: string;
    status: string;
    budget: number;
    budget_units: string;
    currency: string;
    uses_project_invoice_sequence: boolean;
    contract_po_reference?: string;
    hours_per_day?: number;
    normal_billing_rate?: string;
    billing_period?: string;
    is_ir35?: boolean;
    starts_on?: string;
    ends_on?: string;
    include_unbilled_time_in_profitability?: boolean;
}

export interface Project {
    url: string;
    name: string;
    contact: string;
    status: string;
    budget: number;
    budget_units: string;
    currency: string;
    uses_project_invoice_sequence: boolean;
    contract_po_reference?: string;
    hours_per_day?: number;
    normal_billing_rate?: string;
    billing_period?: string;
    is_ir35?: boolean;
    starts_on?: string;
    ends_on?: string;
    include_unbilled_time_in_profitability?: boolean;
    created_at: string;
    updated_at: string;
}

export interface ProjectsResponse {
    projects: Project[];
}

export interface ProjectResponse {
    project: Project;
}

export interface TaskAttributes {
    name: string;
    is_billable?: boolean;
    status?: string;
    billing_rate?: string;
    billing_period?: string;
}

export interface Task {
    url: string;
    name: string;
    project: string;
    status: string;
    is_billable: boolean;
    billing_rate?: string;
    billing_period?: string;
    created_at: string;
    updated_at: string;
}

export interface TasksResponse {
    tasks: Task[];
}

export interface TaskResponse {
    task: Task;
}

export interface User {
    url: string;
    first_name: string;
    last_name: string;
    email: string;
    role: string;
    created_at: string;
    updated_at: string;
}

export interface UsersResponse {
    users: User[];
}

export interface UserResponse {
    user: User;
}

export interface InvoiceItemAttributes {
    id?: string;
    item_type: string;
    description: string;
    quantity: string;
    price: string;
    sales_tax_rate?: string;
    _destroy?: number;
}

export interface InvoiceAttributes {
    contact: string;
    project?: string;
    project_ids?: string[];
    dated_on: string;
    payment_terms_in_days: number;
    currency?: string;
    comments?: string;
    ec_status?: string;
    include_timeslips?: string;
    invoice_items?: InvoiceItemAttributes[];
}

export interface InvoiceItem {
    url: string;
    item_type: string;
    description: string;
    quantity: string;
    price: string;
    sales_tax_rate: string;
    position: number;
}

export interface Invoice {
    url: string;
    contact: string;
    project?: string;
    dated_on: string;
    due_on: string;
    reference: string;
    currency: string;
    status: string;
    net_value: string;
    total_value: string;
    paid_value: string;
    due_value: string;
    payment_terms_in_days: number;
    comments?: string;
    ec_status?: string;
    invoice_items: InvoiceItem[];
    created_at: string;
    updated_at: string;
}

export interface InvoiceResponse {
    invoice: Invoice;
}

export interface InvoicesResponse {
    invoices: Invoice[];
}

export interface InvoicePdfResponse {
    pdf: { content: string };
}

export interface Category {
    url: string;
    description: string;
    nominal_code: string;
    group_description?: string;
    allowable_for_tax?: boolean;
    tax_reporting_name?: string;
    auto_sales_tax_rate?: string;
}

export interface CategoriesResponse {
    admin_expenses_categories: Category[];
    cost_of_sales_categories: Category[];
    income_categories: Category[];
    general_categories: Category[];
}

export interface BankAccount {
    url: string;
    name: string;
    type: string;
    currency: string;
    opening_balance: string;
    status: string;
    created_at: string;
    updated_at: string;
}

export interface BankAccountsResponse {
    bank_accounts: BankAccount[];
}

export interface BankAccountResponse {
    bank_account: BankAccount;
}

export interface BankTransaction {
    url: string;
    amount: string;
    bank_account: string;
    dated_on: string;
    description: string;
    full_description?: string;
    unexplained_amount: string;
    is_manual: boolean;
    transaction_id?: string;
    matching_transactions_count?: number;
    /** Nested when fetched via /bank_transactions with view=all or view=
     *  explained. Empty for unexplained transactions. */
    bank_transaction_explanations?: BankTransactionExplanation[];
    created_at: string;
    updated_at: string;
}

export interface BankTransactionsResponse {
    bank_transactions: BankTransaction[];
}

export interface BankTransactionResponse {
    bank_transaction: BankTransaction;
}

export interface BankTransactionExplanation {
    url: string;
    bank_account?: string;
    bank_transaction?: string;
    type?: string;
    dated_on: string;
    description?: string;
    gross_value: string;
    category?: string;
    sales_tax_rate?: string;
    sales_tax_value?: string;
    ec_status?: string;
    is_deletable?: boolean;
    is_locked?: boolean;
    paid_invoice?: string;
    paid_bill?: string;
    paid_user?: string;
    project?: string;
    rebill_type?: string;
    rebill_factor?: string;
    transfer_bank_account?: string;
    created_at?: string;
    updated_at?: string;
}

export interface BankTransactionExplanationsResponse {
    bank_transaction_explanations: BankTransactionExplanation[];
}

export interface BillItemAttributes {
    category: string;
    description: string;
    total_value: string;
    total_value_ex_tax?: string;
    quantity?: string;
    unit?: string;
    sales_tax_rate?: string;
    sales_tax_status?: string;
}

export interface BillItem {
    url: string;
    bill: string;
    category: string;
    description: string;
    total_value: string;
    total_value_ex_tax?: string;
    quantity?: string;
    unit?: string;
    sales_tax_rate?: string;
    sales_tax_status?: string;
}

export interface BillAttributes {
    contact: string;
    reference: string;
    dated_on: string;
    due_on: string;
    comments?: string;
    category?: string;
    bill_items?: BillItemAttributes[];
}

export interface Bill {
    url: string;
    contact: string;
    reference: string;
    dated_on: string;
    due_on: string;
    paid_on?: string;
    status: string;
    long_status?: string;
    currency: string;
    total_value: string;
    due_value: string;
    net_value?: string;
    sales_tax_value?: string;
    comments?: string;
    project?: string;
    recurring?: boolean;
    bill_items?: BillItem[];
    created_at: string;
    updated_at: string;
}

export interface BillsResponse {
    bills: Bill[];
}

export interface BillResponse {
    bill: Bill;
}

export interface ProfitAndLossDeduction {
    title: string;
    total: string;
}

export interface ProfitAndLossSummary {
    from: string;
    to: string;
    income: string;
    expenses: string;
    operating_profit: string;
    less: ProfitAndLossDeduction[];
    retained_profit: string;
    retained_profit_brought_forward: string;
    retained_profit_carried_forward: string;
}

export interface ProfitAndLossSummaryResponse {
    profit_and_loss_summary: ProfitAndLossSummary;
}

export interface FreeAgentConfig {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
}

// FreeAgent API shapes for POST /bank_transaction_explanations.
export interface BankTransactionExplanationCreatePayload {
    bank_transaction: string;
    dated_on: string;
    gross_value: string;
    description?: string;
    category?: string;
    paid_bill?: string;
    paid_invoice?: string;
    sales_tax_status?: string;
    sales_tax_rate?: string;
    sales_tax_value?: string;
    project?: string;
    marked_for_review?: boolean;
    attachment?: {
        data: string;        // base64-encoded bytes
        file_name: string;
        content_type: string;
        description?: string;
    };
}

export interface BankTransactionExplanationResponse {
    bank_transaction_explanation: BankTransactionExplanation;
}

// =============================================================================
// Employee expenses v1
// FreeAgent's expense resource is a single endpoint that shape-shifts by
// "mode": money expenses, mileage claims, rebillable, recurring, and
// foreign-currency expenses. See the expenses feature design notes for scope.
// =============================================================================

/** Attachment metadata as it appears on a fetched expense (read-only). */
export interface ExpenseAttachment {
    url: string;
    content_src: string;
    content_type: string;
    file_name: string;
    file_size: number;
}

/** A FreeAgent expense as returned by the API. Most fields are optional:
 *  the resource shape varies by expense mode (e.g. mileage claims carry
 *  `mileage`/`vehicle_type` instead of `gross_value`). */
export interface Expense {
    url: string;
    user: string;
    category?: string;
    dated_on: string;
    currency?: string;
    gross_value?: string;
    native_gross_value?: string;
    description?: string;
    receipt_reference?: string;
    sales_tax_rate?: string;
    sales_tax_value?: string;
    sales_tax_status?: string;
    native_sales_tax_value?: string;
    second_sales_tax_rate?: string;
    second_sales_tax_status?: string;
    manual_sales_tax_amount?: string;
    ec_status?: string;
    project?: string;
    rebill_type?: string;
    rebill_factor?: string;
    rebill_to_project?: string;
    /** Read-only: set by FreeAgent once the expense has been rebilled. */
    rebilled_on_invoice?: string;
    recurring?: string;
    next_recurs_on?: string;
    recurring_end_date?: string;
    mileage?: string;
    vehicle_type?: string;
    engine_type?: string;
    engine_size?: string;
    reclaim_mileage?: number;
    initial_rate_mileage?: string;
    reclaim_mileage_rate?: string;
    rebill_mileage_rate?: string;
    have_vat_receipt?: boolean;
    /** Read-only: link to the capital asset auto-created from the expense. */
    capital_asset?: string;
    stock_item?: string;
    stock_item_description?: string;
    stock_altering_quantity?: string;
    property?: string;
    attachment?: ExpenseAttachment;
    created_at: string;
    updated_at: string;
}

export interface ExpensesResponse {
    expenses: Expense[];
}

export interface ExpenseResponse {
    expense: Expense;
}

/** Attachment payload for create/update — base64-encoded bytes. */
export interface ExpenseAttachmentPayload {
    data: string;
    file_name: string;
    content_type: string;
    description?: string;
}

/** FreeAgent wire shape for POST/PUT /expenses (the value of the `expense`
 *  wrapper key). Built from curated tool input by buildExpensePayload in
 *  expenses.ts. Fields beyond the Phase 1 core (mileage, rebill, recurring,
 *  FX) are declared here so the one payload type describes the whole
 *  resource; individual tools gate which fields they actually set. */
export interface ExpenseCreatePayload {
    user: string;
    dated_on: string;
    category?: string;
    gross_value?: string;
    currency?: string;
    native_gross_value?: string;
    description?: string;
    receipt_reference?: string;
    sales_tax_rate?: string;
    sales_tax_value?: string;
    sales_tax_status?: string;
    manual_sales_tax_amount?: string;
    ec_status?: string;
    project?: string;
    rebill_type?: string;
    rebill_factor?: string;
    recurring?: string;
    recurring_end_date?: string;
    property?: string;
    mileage?: string;
    vehicle_type?: string;
    engine_type?: string;
    engine_size?: string;
    reclaim_mileage?: number;
    have_vat_receipt?: boolean;
    attachment?: ExpenseAttachmentPayload;
}

/** One dated period of GET /expenses/mileage_settings — the valid engine
 *  types and their sizes change over time, so options are date-scoped. */
export interface MileageEngineOptionPeriod {
    from?: string;
    to?: string | null;
    /** Engine type (e.g. "Petrol") → list of valid engine sizes. */
    value?: Record<string, string[]>;
}

export interface MileageRatePeriod {
    from?: string;
    to?: string | null;
    value?: Record<string, unknown>;
}

export interface MileageSettings {
    engine_type_and_size_options?: MileageEngineOptionPeriod[];
    mileage_rates?: MileageRatePeriod[];
}

export interface MileageSettingsResponse {
    mileage_settings: MileageSettings;
}
