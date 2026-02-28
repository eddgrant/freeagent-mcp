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

export interface Project {
    url: string;
    name: string;
    contact: string;
    status: string;
    budget: number;
    currency: string;
    created_at: string;
    updated_at: string;
}

export interface ProjectsResponse {
    projects: Project[];
}

export interface ProjectResponse {
    project: Project;
}

export interface Task {
    url: string;
    name: string;
    project: string;
    status: string;
    is_billable: boolean;
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
    item_type: string;
    description: string;
    quantity: string;
    price: string;
    sales_tax_rate?: string;
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

export interface FreeAgentConfig {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
}
