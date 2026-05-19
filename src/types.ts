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

// =============================================================================
// Reconciliation v1
// See TASKS.md ("Reconcile bank transactions (v1)") for the design and
// SECURITY.md for the threat model.
// =============================================================================

export const SCHEMA_VERSION = 1;

export interface Evidence {
    source: string;
    ref_id: string;
    ref_url?: string;
    file_name: string;
    content_type: string;
    extracted?: {
        dated_on?: string;
        gross_value?: string;
        currency?: string;
        sales_tax_value?: string;
        sales_tax_rate?: string;
        merchant?: string;
        sender?: string;
        snippet?: string;
    };
    match_confidence?: number;
}

export interface ProposedExplanation {
    dated_on: string;
    gross_value: string;
    category?: string;
    paid_bill?: string;
    paid_invoice?: string;
    sales_tax_status?: 'TAXABLE' | 'EXEMPT' | 'OUT_OF_SCOPE';
    sales_tax_rate?: string;
    sales_tax_value?: string;
    description?: string;
    project?: string;
    evidence?: Evidence[];
    alternates?: {
        category?: string[];
        evidence?: Evidence[];
    };
    history_match?: {
        merchant_signature: string;
        prior_count: number;
        last_used: string;
        recurring?: { cadence_days: number; confidence: number };
    };
}

export interface ReconciliationProposal {
    proposal_id: string;
    bank_transaction: string;
    explanations: ProposedExplanation[];
    overall_confidence: number;
    rationale: string;
    suggested_searches?: SearchHint[];
}

export interface SearchHint {
    intent: 'find_receipt' | 'find_invoice' | 'find_email_thread';
    around_date: string;
    date_window_days?: number;
    amount?: string;
    amount_tolerance?: string;
    currency?: string;
    merchant_keywords?: string[];
    from_domains?: string[];
    has_attachment?: boolean;
}

export interface ExplanationToApply {
    bank_transaction: string;
    dated_on: string;
    gross_value: string;
    category?: string;
    paid_bill?: string;
    paid_invoice?: string;
    sales_tax_status?: 'TAXABLE' | 'EXEMPT' | 'OUT_OF_SCOPE';
    sales_tax_rate?: string;
    sales_tax_value?: string;
    description?: string;
    project?: string;
    attachment?: {
        evidence_path: string;
        file_name: string;
        content_type: string;
        description?: string;
    };
    marked_for_review?: boolean;

    /** sha256 over the canonical JSON form of:
     *    { bank_transaction, gross_value, dated_on,
     *      one_of: { category | paid_bill | paid_invoice },
     *      description }
     *  with keys sorted before stringification. `description` is in
     *  the hash so legitimate same-day same-amount splits don't collide. */
    idempotency_key: string;

    // v1.x fields — declared so the schema doesn't break when lifted.
    // apply_reconciliations refuses payloads that set any of these in v1.
    foreign_currency_value?: string;
    foreign_currency_rate?: string;
    transfer_bank_account?: string;
}

export type SkipReason =
    | 'already_explained'
    | 'duplicate_of_existing_explanation'
    | 'bill_not_found'
    | 'bill_already_paid'
    | 'invoice_not_found'
    | 'invoice_already_paid'
    | 'period_locked'
    | 'currency_mismatch'
    | 'staging_volume_not_mounted'
    | 'transaction_not_found';

export interface ApplyResult {
    posted: Array<{
        bank_transaction: string;
        explanation_url: string;
        idempotency_key: string;
    }>;
    skipped: Array<{
        bank_transaction: string;
        reason: SkipReason;
        idempotency_key: string;
    }>;
    failed: Array<{
        bank_transaction: string;
        error: string;
        http_status?: number;
        idempotency_key: string;
    }>;
}

// FreeAgent API shape for POST /bank_transaction_explanations.
// apply_reconciliations builds these from ExplanationToApply.
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
