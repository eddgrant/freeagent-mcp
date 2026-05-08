import axios, { AxiosInstance } from 'axios';
import { FreeAgentConfig, Timeslip, TimeslipAttributes, TimeslipsResponse, TimeslipResponse, Project, ProjectAttributes, ProjectsResponse, ProjectResponse, Task, TaskAttributes, TasksResponse, TaskResponse, User, UsersResponse, UserResponse, Invoice, InvoiceAttributes, InvoiceResponse, InvoicesResponse, InvoicePdfResponse, Category, CategoriesResponse, BankAccount, BankAccountsResponse, BankTransaction, BankTransactionsResponse, BankTransactionExplanation, BankTransactionExplanationsResponse, Bill, BillsResponse, BillResponse, ProfitAndLossSummary, ProfitAndLossSummaryResponse } from './types.js';
import { mapWithConcurrency, parseLastPage, parseRetryAfter, readPaginationConcurrency } from './pagination.js';

export class FreeAgentClient {
    private axiosInstance: AxiosInstance;
    private config: FreeAgentConfig;
    private paginationConcurrency: number;

    // Tuning knobs for 429 retry backoff. Exposed as static fields so
    // tests can shrink them to zero without contortions; in production
    // we want a real 1s baseline with exponential growth.
    static retryBaseMs = 1000;
    static retryMaxAttempts = 3;
    static retryJitterMs = 250;

    constructor(config: FreeAgentConfig) {
        this.config = config;
        this.paginationConcurrency = readPaginationConcurrency();
        this.axiosInstance = axios.create({
            baseURL: 'https://api.freeagent.com/v2',
            headers: {
                'Authorization': `Bearer ${config.accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        // 401: refresh OAuth token and retry once. _retried prevents an
        // infinite loop when the refresh token itself is invalid.
        // 429: respect Retry-After when set, otherwise exponential backoff
        // with jitter. _429Attempts caps total retries.
        this.axiosInstance.interceptors.response.use(
            response => response,
            async error => {
                if (error.response?.status === 401 && !error.config._retried) {
                    error.config._retried = true;
                    await this.refreshToken();
                    error.config.headers['Authorization'] = `Bearer ${this.config.accessToken}`;
                    return this.axiosInstance.request(error.config);
                }
                if (error.response?.status === 429) {
                    const cfg = error.config;
                    cfg._429Attempts = (cfg._429Attempts ?? 0) + 1;
                    if (cfg._429Attempts > FreeAgentClient.retryMaxAttempts) {
                        console.error(`[API] 429 after ${FreeAgentClient.retryMaxAttempts} retries — giving up`);
                        return Promise.reject(error);
                    }
                    const retryAfter = parseRetryAfter(error.response.headers?.['retry-after']);
                    const exp = FreeAgentClient.retryBaseMs * Math.pow(2, cfg._429Attempts - 1);
                    const jitter = Math.floor(Math.random() * FreeAgentClient.retryJitterMs);
                    const delay = (retryAfter ?? exp) + jitter;
                    console.error(`[API] 429 received, retry ${cfg._429Attempts}/${FreeAgentClient.retryMaxAttempts} after ${delay}ms`);
                    await new Promise(r => setTimeout(r, delay));
                    return this.axiosInstance.request(cfg);
                }
                return Promise.reject(error);
            }
        );
    }

    // Every paginated FreeAgent list endpoint is fetched through this
    // helper. We fetch page 1, parse `last` from the Link header's
    // rel='last' segment, then fan out pages 2..last with bounded
    // concurrency. PER_PAGE=100 is the FreeAgent API maximum.
    //
    // If page 1 was full but we can't extract a page count from Link,
    // we throw rather than silently truncate. The probe found Link
    // headers on every paginated endpoint, so this branch is a contract
    // violation rather than an expected case — we want to find out
    // immediately if FreeAgent ever changes that.
    private async paginatedGet<T>(
        path: string,
        key: string,
        baseParams: Record<string, unknown> = {},
    ): Promise<T[]> {
        const PER_PAGE = 100;
        const first = await this.axiosInstance.get<Record<string, T[]>>(path, {
            params: { ...baseParams, page: 1, per_page: PER_PAGE },
        });
        const firstBatch: T[] = first.data[key] ?? [];

        // Fast exit: page 1 was short (or empty), so there are no more pages.
        if (firstBatch.length < PER_PAGE) {
            console.error(`[API] ${path}: fetched ${firstBatch.length} item(s) in 1 page`);
            return firstBatch;
        }

        const lastPage = parseLastPage(first.headers?.link);
        if (lastPage == null) {
            throw new Error(
                `${path}: page 1 was full but the Link header did not include a parseable rel='last' page count. ` +
                `Cannot determine remaining page count safely. Re-run scripts/probe-pagination.mjs to verify the API contract.`,
            );
        }
        if (lastPage <= 1) return firstBatch;

        const remainingPages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
        const batches = await mapWithConcurrency(remainingPages, this.paginationConcurrency, async (page) => {
            const r = await this.axiosInstance.get<Record<string, T[]>>(path, {
                params: { ...baseParams, page, per_page: PER_PAGE },
            });
            return (r.data[key] ?? []) as T[];
        });

        const out: T[] = [...firstBatch];
        for (const b of batches) out.push(...b);
        console.error(`[API] ${path}: fetched ${out.length} item(s) across ${lastPage} page(s) (concurrency=${this.paginationConcurrency})`);
        return out;
    }

    private async refreshToken() {
        try {
            const response = await axios.post('https://api.freeagent.com/v2/token_endpoint', {
                grant_type: 'refresh_token',
                refresh_token: this.config.refreshToken,
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret
            });

            this.config.accessToken = response.data.access_token;
            this.config.refreshToken = response.data.refresh_token;

            this.axiosInstance.defaults.headers['Authorization'] = `Bearer ${this.config.accessToken}`;

            console.error('[Auth] Successfully refreshed access token');
        } catch (error: any) {
            console.error('[Auth] Failed to refresh token:', error.message);
            throw error;
        }
    }

    async listTimeslips(params?: {
        from_date?: string;
        to_date?: string;
        updated_since?: string;
        view?: 'all' | 'unbilled' | 'running';
        user?: string;
        task?: string;
        project?: string;
        nested?: boolean;
    }): Promise<Timeslip[]> {
        try {
            console.error('[API] Fetching timeslips with params:', params);
            return await this.paginatedGet<Timeslip>('/timeslips', 'timeslips', params ?? {});
        } catch (error: any) {
            console.error('[API] Failed to fetch timeslips:', error.message);
            throw error;
        }
    }

    async getTimeslip(id: string): Promise<Timeslip> {
        try {
            console.error('[API] Fetching timeslip:', id);
            const response = await this.axiosInstance.get<TimeslipResponse>(`/timeslips/${id}`);
            return response.data.timeslip;
        } catch (error: any) {
            console.error('[API] Failed to fetch timeslip:', error.message);
            throw error;
        }
    }

    async createTimeslip(timeslip: TimeslipAttributes): Promise<Timeslip> {
        try {
            console.error('[API] Creating timeslip:', timeslip);
            const response = await this.axiosInstance.post<TimeslipResponse>('/timeslips', {
                timeslip
            });
            return response.data.timeslip;
        } catch (error: any) {
            console.error('[API] Failed to create timeslip:', error.message);
            throw error;
        }
    }

    async createTimeslips(timeslips: TimeslipAttributes[]): Promise<Timeslip[]> {
        try {
            console.error('[API] Creating multiple timeslips:', timeslips);
            const response = await this.axiosInstance.post<TimeslipsResponse>('/timeslips', {
                timeslips
            });
            return response.data.timeslips;
        } catch (error: any) {
            console.error('[API] Failed to create timeslips:', error.message);
            throw error;
        }
    }

    async updateTimeslip(id: string, timeslip: Partial<TimeslipAttributes>): Promise<Timeslip> {
        try {
            console.error('[API] Updating timeslip:', id, timeslip);
            const response = await this.axiosInstance.put<TimeslipResponse>(`/timeslips/${id}`, {
                timeslip
            });
            return response.data.timeslip;
        } catch (error: any) {
            console.error('[API] Failed to update timeslip:', error.message);
            throw error;
        }
    }

    async deleteTimeslip(id: string): Promise<void> {
        try {
            console.error('[API] Deleting timeslip:', id);
            await this.axiosInstance.delete(`/timeslips/${id}`);
        } catch (error: any) {
            console.error('[API] Failed to delete timeslip:', error.message);
            throw error;
        }
    }

    async startTimer(id: string): Promise<Timeslip> {
        try {
            console.error('[API] Starting timer for timeslip:', id);
            const response = await this.axiosInstance.post<TimeslipResponse>(`/timeslips/${id}/timer`);
            return response.data.timeslip;
        } catch (error: any) {
            console.error('[API] Failed to start timer:', error.message);
            throw error;
        }
    }

    async stopTimer(id: string): Promise<Timeslip> {
        try {
            console.error('[API] Stopping timer for timeslip:', id);
            const response = await this.axiosInstance.delete<TimeslipResponse>(`/timeslips/${id}/timer`);
            return response.data.timeslip;
        } catch (error: any) {
            console.error('[API] Failed to stop timer:', error.message);
            throw error;
        }
    }

    async createProject(project: ProjectAttributes): Promise<Project> {
        try {
            console.error('[API] Creating project:', project);
            const response = await this.axiosInstance.post<ProjectResponse>('/projects', {
                project
            });
            return response.data.project;
        } catch (error: any) {
            console.error('[API] Failed to create project:', error.message);
            throw error;
        }
    }

    async getProject(id: string): Promise<Project> {
        try {
            console.error('[API] Fetching project:', id);
            const response = await this.axiosInstance.get<ProjectResponse>(`/projects/${id}`);
            return response.data.project;
        } catch (error: any) {
            console.error('[API] Failed to fetch project:', error.message);
            throw error;
        }
    }

    async listProjects(params?: {
        view?: string;
        sort?: string;
        contact?: string;
    }): Promise<Project[]> {
        try {
            console.error('[API] Fetching projects with params:', params);
            return await this.paginatedGet<Project>('/projects', 'projects', params ?? {});
        } catch (error: any) {
            console.error('[API] Failed to fetch projects:', error.message);
            throw error;
        }
    }

    async createTask(projectUrl: string, task: TaskAttributes): Promise<Task> {
        try {
            console.error('[API] Creating task:', task, 'for project:', projectUrl);
            const response = await this.axiosInstance.post<TaskResponse>('/tasks', {
                task
            }, {
                params: { project: projectUrl }
            });
            return response.data.task;
        } catch (error: any) {
            console.error('[API] Failed to create task:', error.message);
            throw error;
        }
    }

    async listTasks(params?: {
        project?: string;
        view?: string;
        sort?: string;
    }): Promise<Task[]> {
        try {
            console.error('[API] Fetching tasks with params:', params);
            return await this.paginatedGet<Task>('/tasks', 'tasks', params ?? {});
        } catch (error: any) {
            console.error('[API] Failed to fetch tasks:', error.message);
            throw error;
        }
    }

    async getCurrentUser(): Promise<User> {
        try {
            console.error('[API] Fetching current user');
            const response = await this.axiosInstance.get<UserResponse>('/users/me');
            return response.data.user;
        } catch (error: any) {
            console.error('[API] Failed to fetch current user:', error.message);
            throw error;
        }
    }

    async listUsers(params?: {
        view?: string;
    }): Promise<User[]> {
        try {
            console.error('[API] Fetching users with params:', params);
            return await this.paginatedGet<User>('/users', 'users', params ?? {});
        } catch (error: any) {
            console.error('[API] Failed to fetch users:', error.message);
            throw error;
        }
    }

    async createInvoice(invoice: InvoiceAttributes): Promise<Invoice> {
        try {
            console.error('[API] Creating invoice:', invoice);
            const response = await this.axiosInstance.post<InvoiceResponse>('/invoices', {
                invoice
            });
            return response.data.invoice;
        } catch (error: any) {
            console.error('[API] Failed to create invoice:', error.message);
            throw error;
        }
    }

    async listInvoices(params?: {
        project?: string;
        contact?: string;
        view?: string;
        sort?: string;
        updated_since?: string;
    }): Promise<Invoice[]> {
        try {
            console.error('[API] Fetching invoices with params:', params);
            return await this.paginatedGet<Invoice>('/invoices', 'invoices', params ?? {});
        } catch (error: any) {
            console.error('[API] Failed to fetch invoices:', error.message);
            throw error;
        }
    }

    async getInvoice(id: string): Promise<Invoice> {
        try {
            console.error('[API] Fetching invoice:', id);
            const response = await this.axiosInstance.get<InvoiceResponse>(`/invoices/${id}`);
            return response.data.invoice;
        } catch (error: any) {
            console.error('[API] Failed to fetch invoice:', error.message);
            throw error;
        }
    }

    async updateInvoice(id: string, invoice: Partial<InvoiceAttributes>): Promise<Invoice> {
        try {
            console.error('[API] Updating invoice:', id, invoice);
            const response = await this.axiosInstance.put<InvoiceResponse>(`/invoices/${id}`, {
                invoice
            });
            return response.data.invoice;
        } catch (error: any) {
            console.error('[API] Failed to update invoice:', error.message);
            throw error;
        }
    }

    async downloadInvoicePdf(id: string): Promise<string> {
        try {
            console.error('[API] Downloading invoice PDF:', id);
            const response = await this.axiosInstance.get<InvoicePdfResponse>(`/invoices/${id}/pdf`);
            return response.data.pdf.content;
        } catch (error: any) {
            console.error('[API] Failed to download invoice PDF:', error.message);
            throw error;
        }
    }

    async deleteInvoice(id: string): Promise<void> {
        try {
            console.error('[API] Deleting invoice:', id);
            await this.axiosInstance.delete(`/invoices/${id}`);
        } catch (error: any) {
            console.error('[API] Failed to delete invoice:', error.message);
            throw error;
        }
    }

    async markInvoiceAsDraft(id: string): Promise<Invoice> {
        try {
            console.error('[API] Marking invoice as draft:', id);
            const response = await this.axiosInstance.put<InvoiceResponse>(
                `/invoices/${id}/transitions/mark_as_draft`,
                null,
                { headers: { 'Content-Length': '0' } }
            );
            return response.data.invoice;
        } catch (error: any) {
            console.error('[API] Failed to mark invoice as draft:', error.message);
            throw error;
        }
    }

    // Intentionally not paginated: /categories returns a fixed grouped
    // taxonomy (admin_expenses_categories, cost_of_sales_categories,
    // income_categories, general_categories) and the API does not
    // emit a Link header here. Verified via scripts/probe-pagination.mjs.
    async listCategories(params?: {
        sub_accounts?: boolean;
    }): Promise<CategoriesResponse> {
        try {
            console.error('[API] Fetching categories with params:', params);
            const response = await this.axiosInstance.get<CategoriesResponse>('/categories', { params });
            return response.data;
        } catch (error: any) {
            console.error('[API] Failed to fetch categories:', error.message);
            throw error;
        }
    }

    async listBankAccounts(): Promise<BankAccount[]> {
        try {
            console.error('[API] Fetching bank accounts');
            return await this.paginatedGet<BankAccount>('/bank_accounts', 'bank_accounts');
        } catch (error: any) {
            console.error('[API] Failed to fetch bank accounts:', error.message);
            throw error;
        }
    }

    async listBankTransactions(params: {
        bank_account: string;
        from_date?: string;
        to_date?: string;
        updated_since?: string;
        view?: 'all' | 'unexplained' | 'explained' | 'manual' | 'imported' | 'marked_for_review';
    }): Promise<BankTransaction[]> {
        try {
            console.error('[API] Fetching bank transactions with params:', params);
            return await this.paginatedGet<BankTransaction>('/bank_transactions', 'bank_transactions', params);
        } catch (error: any) {
            console.error('[API] Failed to fetch bank transactions:', error.message);
            throw error;
        }
    }

    async listBankTransactionExplanations(params: {
        bank_account: string;
        from_date?: string;
        to_date?: string;
        updated_since?: string;
    }): Promise<BankTransactionExplanation[]> {
        try {
            console.error('[API] Fetching bank transaction explanations with params:', params);
            return await this.paginatedGet<BankTransactionExplanation>('/bank_transaction_explanations', 'bank_transaction_explanations', params);
        } catch (error: any) {
            console.error('[API] Failed to fetch bank transaction explanations:', error.message);
            throw error;
        }
    }

    async listBills(params?: {
        from_date?: string;
        to_date?: string;
        updated_since?: string;
        contact?: string;
        project?: string;
        view?: 'all' | 'open' | 'overdue' | 'open_or_overdue' | 'paid' | 'recurring' | 'hire_purchase' | 'cis';
        nested_bill_items?: boolean;
    }): Promise<Bill[]> {
        try {
            console.error('[API] Fetching bills with params:', params);
            return await this.paginatedGet<Bill>('/bills', 'bills', params ?? {});
        } catch (error: any) {
            console.error('[API] Failed to fetch bills:', error.message);
            throw error;
        }
    }

    async getBill(id: string): Promise<Bill> {
        try {
            console.error('[API] Fetching bill:', id);
            const response = await this.axiosInstance.get<BillResponse>(`/bills/${id}`);
            return response.data.bill;
        } catch (error: any) {
            console.error('[API] Failed to fetch bill:', error.message);
            throw error;
        }
    }

    async getProfitAndLossSummary(params?: {
        from_date?: string;
        to_date?: string;
        accounting_period?: string;
    }): Promise<ProfitAndLossSummary> {
        try {
            console.error('[API] Fetching profit and loss summary with params:', params);
            const response = await this.axiosInstance.get<ProfitAndLossSummaryResponse>('/accounting/profit_and_loss/summary', { params });
            return response.data.profit_and_loss_summary;
        } catch (error: any) {
            console.error('[API] Failed to fetch profit and loss summary:', error.message);
            throw error;
        }
    }

    async markInvoiceAsSent(id: string): Promise<Invoice> {
        try {
            console.error('[API] Marking invoice as sent:', id);
            const response = await this.axiosInstance.put<InvoiceResponse>(
                `/invoices/${id}/transitions/mark_as_sent`,
                null,
                { headers: { 'Content-Length': '0' } }
            );
            return response.data.invoice;
        } catch (error: any) {
            console.error('[API] Failed to mark invoice as sent:', error.message);
            throw error;
        }
    }
}
