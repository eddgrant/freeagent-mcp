import axios, { AxiosInstance } from 'axios';
import { FreeAgentConfig, Timeslip, TimeslipAttributes, TimeslipsResponse, TimeslipResponse, Project, ProjectsResponse, Task, TasksResponse, User, UsersResponse, UserResponse, Invoice, InvoiceAttributes, InvoiceResponse, InvoicesResponse, InvoicePdfResponse } from './types.js';

export class FreeAgentClient {
    private axiosInstance: AxiosInstance;
    private config: FreeAgentConfig;

    constructor(config: FreeAgentConfig) {
        this.config = config;
        this.axiosInstance = axios.create({
            baseURL: 'https://api.freeagent.com/v2',
            headers: {
                'Authorization': `Bearer ${config.accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        // Refresh the OAuth token on 401 responses. The _retried flag prevents
        // an infinite loop when the refresh token itself is invalid or expired.
        this.axiosInstance.interceptors.response.use(
            response => response,
            async error => {
                if (error.response?.status === 401 && !error.config._retried) {
                    error.config._retried = true;
                    await this.refreshToken();
                    error.config.headers['Authorization'] = `Bearer ${this.config.accessToken}`;
                    return this.axiosInstance.request(error.config);
                }
                return Promise.reject(error);
            }
        );
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
            const response = await this.axiosInstance.get<TimeslipsResponse>('/timeslips', { params });
            return response.data.timeslips;
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

    async listProjects(params?: {
        view?: string;
        sort?: string;
        contact?: string;
    }): Promise<Project[]> {
        try {
            console.error('[API] Fetching projects with params:', params);
            const response = await this.axiosInstance.get<ProjectsResponse>('/projects', { params });
            return response.data.projects;
        } catch (error: any) {
            console.error('[API] Failed to fetch projects:', error.message);
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
            const response = await this.axiosInstance.get<TasksResponse>('/tasks', { params });
            return response.data.tasks;
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
            const response = await this.axiosInstance.get<UsersResponse>('/users', { params });
            return response.data.users;
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
    }): Promise<Invoice[]> {
        try {
            console.error('[API] Fetching invoices with params:', params);
            const response = await this.axiosInstance.get<InvoicesResponse>('/invoices', { params });
            return response.data.invoices;
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
