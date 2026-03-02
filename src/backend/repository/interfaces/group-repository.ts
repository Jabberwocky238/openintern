import type { AddMember, CreateGroup, Group, GroupMember } from '../../../types/orchestrator.js';

export interface GroupRoleMemberView {
  role_id: string;
  role_name: string;
  role_description: string;
}

export interface GroupWithRolesView extends Group {
  members: GroupRoleMemberView[];
}

export interface GroupRunRecord {
  run_id: string;
  status: string;
  input: string;
  created_at: string;
  ended_at: string | null;
  duration_ms: number | null;
}

export interface IGroupRepository {
  createGroup(input: CreateGroup): Promise<Group>;
  getGroup(id: string): Promise<Group | null>;
  requireGroup(id: string): Promise<Group>;
  listGroups(projectId?: string): Promise<Group[]>;
  listGroupsWithRoles(projectId?: string): Promise<GroupWithRolesView[]>;
  addMember(groupId: string, input: AddMember): Promise<GroupMember>;
  listMembers(groupId: string): Promise<GroupMember[]>;
  removeMember(groupId: string, memberId: string): Promise<boolean>;
  updateGroup(
    id: string,
    fields: Partial<Pick<Group, 'name' | 'description' | 'project_id'>>
  ): Promise<Group>;
  assignProjectId(projectId: string, includeExisting?: boolean): Promise<number>;
  deleteGroup(id: string): Promise<boolean>;
  updateMember(groupId: string, memberId: string, fields: { ordinal?: number }): Promise<GroupMember>;
  getGroupStats(groupId: string): Promise<{
    run_count: number;
    completed_count: number;
    failed_count: number;
    success_rate: number;
    avg_duration_ms: number | null;
  }>;
  getGroupRuns(groupId: string, limit?: number, offset?: number): Promise<GroupRunRecord[]>;
}
