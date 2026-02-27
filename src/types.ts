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

export interface FreeAgentConfig {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
}
