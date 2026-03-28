import { campaignTaskRepository } from "./campaign_task.repository";
import { reportRepository } from "../../report/report.repository";
import { campaignManagerService } from "../campaign_manager/campaign_manager.service";
import { reportVolunteerService } from "../../report/report_volunteer/report_volunteer.service";
import { TaskStatus } from "../../../constants/status.enum";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";

// Task DTOs (copied from task module)
export interface CreateTaskRequest {
  reportId: string;
  title: string;
  description?: string;
  scheduledTime?: string; // ISO date string
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: TaskStatus;
  scheduledTime?: string;
}

export interface TaskResponse {
  id: string;
  reportId: string | null;
  title: string | null;
  description: string | null;
  status: number;
  scheduledTime: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskDetailResponse extends TaskResponse {
  assignments: CampaignTaskAssignmentResponse[];
}

export interface CampaignTaskAssignmentResponse {
  id: string;
  campaignTaskId: string | null;
  volunteerId: string | null;
  createdAt: Date;
}

export class CampaignTaskService {
  constructor() {}

  /**
   * Create a task for a report
   * Only reporter or managers can create tasks
   */
  async createTask(
    userId: string,
    request: CreateTaskRequest,
  ): Promise<TaskResponse> {
    // Check if report exists
    const report = await reportRepository.findById(request.reportId);
    if (!report) {
      throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
    }

    // Check if user can manage the report
    const canManage = await campaignManagerService.canManageReport(
      request.reportId,
      userId,
    );
    if (!canManage) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only reporter or managers can create tasks",
        ),
      );
    }

    const task = await campaignTaskRepository.create({
      report: { connect: { id: request.reportId } },
      title: request.title,
      description: request.description,
      scheduledTime: request.scheduledTime
        ? new Date(request.scheduledTime)
        : undefined,
      createdBy: userId,
      status: TaskStatus._STATUS_TODO,
    });

    return this.toTaskResponse(task);
  }

  /**
   * Get task by ID
   */
  async getTaskById(id: string): Promise<TaskResponse | null> {
    const task = await campaignTaskRepository.findById(id);
    return task ? this.toTaskResponse(task) : null;
  }

  /**
   * Get task with assignments
   */
  async getTaskDetail(id: string): Promise<TaskDetailResponse | null> {
    const task = await campaignTaskRepository.findByIdWithAssignments(id);
    if (!task) return null;

    return {
      ...this.toTaskResponse(task),
      assignments: task.campaignTaskAssignments.map((a) => ({
        id: a.id,
        campaignTaskId: a.campaignTaskId,
        volunteerId: a.volunteerId,
        createdAt: a.createdAt,
      })),
    };
  }

  /**
   * Get all tasks for a report
   */
  async getReportTasks(reportId: string): Promise<TaskDetailResponse[]> {
    const tasks = await campaignTaskRepository.findByReportId(reportId);
    return tasks.map((task) => ({
      ...this.toTaskResponse(task),
      assignments: task.campaignTaskAssignments.map((a) => ({
        id: a.id,
        campaignTaskId: a.campaignTaskId,
        volunteerId: a.volunteerId,
        createdAt: a.createdAt,
      })),
    }));
  }

  /**
   * Update a task
   * Only reporter or managers can update tasks
   */
  async updateTask(
    taskId: string,
    userId: string,
    request: UpdateTaskRequest,
  ): Promise<TaskResponse> {
    const task = await campaignTaskRepository.findById(taskId);
    if (!task) {
      throw new HttpError(HTTP_STATUS.TASK_NOT_FOUND);
    }

    if (!task.reportId) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage("Task has no associated report"),
      );
    }

    // Check if user can manage the report
    const canManage = await campaignManagerService.canManageReport(
      task.reportId,
      userId,
    );
    if (!canManage) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only reporter or managers can update tasks",
        ),
      );
    }

    const updated = await campaignTaskRepository.update(taskId, {
      title: request.title,
      description: request.description,
      status: request.status,
      scheduledTime: request.scheduledTime
        ? new Date(request.scheduledTime)
        : undefined,
    });

    return this.toTaskResponse(updated);
  }

  /**
   * Delete a task
   * Only reporter or managers can delete tasks
   */
  async deleteTask(taskId: string, userId: string): Promise<void> {
    const task = await campaignTaskRepository.findById(taskId);
    if (!task) {
      throw new HttpError(HTTP_STATUS.TASK_NOT_FOUND);
    }

    if (!task.reportId) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage("Task has no associated report"),
      );
    }

    // Check if user can manage the report
    const canManage = await campaignManagerService.canManageReport(
      task.reportId,
      userId,
    );
    if (!canManage) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only reporter or managers can delete tasks",
        ),
      );
    }

    await campaignTaskRepository.softDelete(taskId);
  }

  /**
   * Assign a task to a volunteer
   * Only reporter or managers can assign tasks
   * Volunteer must be approved for the report
   */
  async assignTask(
    taskId: string,
    volunteerId: string,
    assignedBy: string,
  ): Promise<CampaignTaskAssignmentResponse> {
    const task = await campaignTaskRepository.findById(taskId);
    if (!task) {
      throw new HttpError(HTTP_STATUS.TASK_NOT_FOUND);
    }

    if (!task.reportId) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage("Task has no associated report"),
      );
    }

    // Check if user can manage the report
    const canManage = await campaignManagerService.canManageReport(
      task.reportId,
      assignedBy,
    );
    if (!canManage) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only reporter or managers can assign tasks",
        ),
      );
    }

    // Check if volunteer is approved for the report
    const isApproved = await reportVolunteerService.isApprovedVolunteer(
      task.reportId,
      volunteerId,
    );
    if (!isApproved) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Volunteer must be approved for this report before being assigned tasks",
        ),
      );
    }

    // Check if already assigned
    const existing = await campaignTaskRepository.findAssignment(
      taskId,
      volunteerId,
    );
    if (existing) {
      throw new HttpError(
        HTTP_STATUS.CONFLICT.withMessage(
          "Volunteer is already assigned to this task",
        ),
      );
    }

    const assignment = await campaignTaskRepository.createAssignment({
      campaignTaskId: taskId,
      volunteerId,
    });

    // Update task status to in_progress if it was open
    if (task.status === TaskStatus._STATUS_TODO) {
      await campaignTaskRepository.update(taskId, {
        status: TaskStatus._STATUS_INPROCESS,
      });
    }

    // TODO: Send notification to volunteer about task assignment
    // await notificationService.notifyVolunteerAboutTaskAssignment(volunteerId, taskId);

    return {
      id: assignment.id,
      campaignTaskId: assignment.campaignTaskId,
      volunteerId: assignment.volunteerId,
      createdAt: assignment.createdAt,
    };
  }

  /**
   * Remove volunteer from task
   */
  async unassignTask(
    taskId: string,
    volunteerId: string,
    removedBy: string,
  ): Promise<void> {
    const task = await campaignTaskRepository.findById(taskId);
    if (!task) {
      throw new HttpError(HTTP_STATUS.TASK_NOT_FOUND);
    }

    if (!task.reportId) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage("Task has no associated report"),
      );
    }

    // Check if user can manage the report
    const canManage = await campaignManagerService.canManageReport(
      task.reportId,
      removedBy,
    );
    if (!canManage) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only reporter or managers can unassign tasks",
        ),
      );
    }

    const assignment = await campaignTaskRepository.findAssignment(
      taskId,
      volunteerId,
    );
    if (!assignment) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage(
          "Volunteer is not assigned to this task",
        ),
      );
    }

    await campaignTaskRepository.removeAssignment(assignment.id);
  }

  /**
   * Get tasks assigned to a volunteer
   */
  async getMyAssignedTasks(volunteerId: string) {
    const assignments =
      await campaignTaskRepository.findAssignmentsByVolunteerId(volunteerId);
    return assignments.map((a) => ({
      assignment: {
        id: a.id,
        campaignTaskId: a.campaignTaskId,
        volunteerId: a.volunteerId,
        createdAt: a.createdAt,
      },
      task: a.campaignTask
        ? {
            id: a.campaignTask.id,
            reportId: a.campaignTask.reportId,
            title: a.campaignTask.title,
            description: a.campaignTask.description,
            status: a.campaignTask.status,
            scheduledTime: a.campaignTask.scheduledTime,
            createdBy: a.campaignTask.createdBy,
            createdAt: a.campaignTask.createdAt,
            report: a.campaignTask.report,
          }
        : null,
    }));
  }

  /**
   * Update task status (by assigned volunteer)
   */
  async updateTaskStatusByVolunteer(
    taskId: string,
    volunteerId: string,
    status: TaskStatus._STATUS_INPROCESS | TaskStatus._STATUS_COMPLETED,
  ): Promise<TaskResponse> {
    const task = await campaignTaskRepository.findById(taskId);
    if (!task) {
      throw new HttpError(HTTP_STATUS.TASK_NOT_FOUND);
    }

    // Check if volunteer is assigned to this task
    const assignment = await campaignTaskRepository.findAssignment(
      taskId,
      volunteerId,
    );
    if (!assignment) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage("You are not assigned to this task"),
      );
    }

    const updated = await campaignTaskRepository.update(taskId, { status });
    return this.toTaskResponse(updated);
  }

  private toTaskResponse(task: any): TaskResponse {
    return {
      id: task.id,
      reportId: task.reportId,
      title: task.title,
      description: task.description,
      status: task.status,
      scheduledTime: task.scheduledTime,
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }
}

// Singleton instance
export const campaignTaskService = new CampaignTaskService();
