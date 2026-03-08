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

export interface BankTransaction {
    url: string;
    amount: string;
    bank_account: string;
    dated_on: string;
    description: string;
    full_description?: string;
    unexplained_amount: string;
    is_manual: boolean;
    created_at: string;
    updated_at: string;
}

export interface BankTransactionsResponse {
    bank_transactions: BankTransaction[];
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

export interface FreeAgentConfig {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
}
