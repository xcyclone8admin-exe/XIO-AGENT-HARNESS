import { uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';

export interface Project extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'paused' | 'complete';
}
export interface Task extends Record<string, unknown> {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  assignee_id: string | null;
  due_at: Date | null;
}

export class OpsService {
  constructor(private readonly store: LocalScopedStore) {}

  async projects(scope: Scope): Promise<Project[]> {
    const result = await this.store.query<Project>(scope,
      `SELECT id,name,description,status FROM ops_projects
       WHERE workspace_id=$1 ORDER BY created_at DESC`, [scope.workspaceId]);
    return result.rows;
  }

  async tasks(scope: Scope, projectId?: string): Promise<Task[]> {
    const sql = projectId
      ? `SELECT id,project_id,title,description,status,assignee_id,due_at FROM ops_tasks
         WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC`
      : `SELECT id,project_id,title,description,status,assignee_id,due_at FROM ops_tasks
         WHERE workspace_id=$1 ORDER BY created_at DESC`;
    const result = await this.store.query<Task>(scope, sql,
      projectId ? [scope.workspaceId, projectId] : [scope.workspaceId]);
    return result.rows;
  }

  async createProject(scope: Scope, actorId: string, name: string, description = ''): Promise<Project> {
    const result = await this.store.query<Project>(scope,
      `INSERT INTO ops_projects(id,tenant_id,workspace_id,name,description,created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,description,status`,
      [uuidv7(), scope.tenantId, scope.workspaceId, name, description, actorId]);
    if (!result.rows[0]) throw new Error('Project insert failed');
    return result.rows[0];
  }

  async createTask(scope: Scope, actorId: string, projectId: string, title: string,
    description = ''): Promise<Task> {
    const result = await this.store.query<Task>(scope,
      `INSERT INTO ops_tasks(id,tenant_id,workspace_id,project_id,title,description,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,project_id,title,description,status,assignee_id,due_at`,
      [uuidv7(), scope.tenantId, scope.workspaceId, projectId, title, description, actorId]);
    if (!result.rows[0]) throw new Error('Task insert failed');
    return result.rows[0];
  }

  async setTaskStatus(scope: Scope, taskId: string, status: Task['status']): Promise<Task | null> {
    const result = await this.store.query<Task>(scope,
      `UPDATE ops_tasks SET status=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3
       RETURNING id,project_id,title,description,status,assignee_id,due_at`,
      [status, taskId, scope.workspaceId]);
    return result.rows[0] ?? null;
  }
}
