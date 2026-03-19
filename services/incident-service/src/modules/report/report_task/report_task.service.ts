import { reportTaskRepository } from "./report_task.repository";
import { reportRepository } from "../report.repository";
import { reportManagerService } from "../report_manager/report_manager.service";
import { reportVolunteerService } from "../report_volunteer/report_volunteer.service";
import { TaskStatus } from "../../../constants/status.enum";

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
  status: string;
  scheduledTime: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskDetailResponse extends TaskResponse {
  assignments: TaskAssignmentResponse[];
}

export interface TaskAssignmentResponse {
  id: string;
  reportTaskId: string | null;
  volunteerId: string | null;
  createdAt: Date;
}

export class ReportTaskService {
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
      throw new Error("Report not found");
    }

    // Check if user can manage the report
    const canManage = await reportManagerService.canManageReport(
      request.reportId,
      userId,
    );
    if (!canManage) {
      throw new Error("Only reporter or managers can create tasks");
    }

    const task = await reportTaskRepository.create({
      report: { connect: { id: request.reportId } },
      title: request.title,
      description: request.description,
      scheduledTime: request.scheduledTime
        ? new Date(request.scheduledTime)
        : undefined,
      createdBy: userId,
      status: TaskStatus.OPEN,
    });

    return this.toTaskResponse(task);
  }

  /**
   * Get task by ID
   */
  async getTaskById(id: string): Promise<TaskResponse | null> {
    const task = await reportTaskRepository.findById(id);
    return task ? this.toTaskResponse(task) : null;
  }

  /**
   * Get task with assignments
   */
  async getTaskDetail(id: string): Promise<TaskDetailResponse | null> {
    const task = await reportTaskRepository.findByIdWithAssignments(id);
    if (!task) return null;

    return {
      ...this.toTaskResponse(task),
      assignments: task.taskAssignments.map((a) => ({
        id: a.id,
        reportTaskId: a.reportTaskId,
        volunteerId: a.volunteerId,
        createdAt: a.createdAt,
      })),
    };
  }

  /**
   * Get all tasks for a report
   */
  async getReportTasks(reportId: string): Promise<TaskDetailResponse[]> {
    const tasks = await reportTaskRepository.findByReportId(reportId);
    return tasks.map((task) => ({
      ...this.toTaskResponse(task),
      assignments: task.taskAssignments.map((a) => ({
        id: a.id,
        reportTaskId: a.reportTaskId,
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
    const task = await reportTaskRepository.findById(taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    if (!task.reportId) {
      throw new Error("Task has no associated report");
    }

    // Check if user can manage the report
    const canManage = await reportManagerService.canManageReport(
      task.reportId,
      userId,
    );
    if (!canManage) {
      throw new Error("Only reporter or managers can update tasks");
    }

    const updated = await reportTaskRepository.update(taskId, {
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
    const task = await reportTaskRepository.findById(taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    if (!task.reportId) {
      throw new Error("Task has no associated report");
    }

    // Check if user can manage the report
    const canManage = await reportManagerService.canManageReport(
      task.reportId,
      userId,
    );
    if (!canManage) {
      throw new Error("Only reporter or managers can delete tasks");
    }

    await reportTaskRepository.softDelete(taskId);
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
  ): Promise<TaskAssignmentResponse> {
    const task = await reportTaskRepository.findById(taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    if (!task.reportId) {
      throw new Error("Task has no associated report");
    }

    // Check if user can manage the report
    const canManage = await reportManagerService.canManageReport(
      task.reportId,
      assignedBy,
    );
    if (!canManage) {
      throw new Error("Only reporter or managers can assign tasks");
    }

    // Check if volunteer is approved for the report
    const isApproved = await reportVolunteerService.isApprovedVolunteer(
      task.reportId,
      volunteerId,
    );
    if (!isApproved) {
      throw new Error(
        "Volunteer must be approved for this report before being assigned tasks",
      );
    }

    // Check if already assigned
    const existing = await reportTaskRepository.findAssignment(
      taskId,
      volunteerId,
    );
    if (existing) {
      throw new Error("Volunteer is already assigned to this task");
    }

    const assignment = await reportTaskRepository.createAssignment({
      reportTaskId: taskId,
      volunteerId,
    });

    // Update task status to in_progress if it was open
    if (task.status === TaskStatus.OPEN) {
      await reportTaskRepository.update(taskId, {
        status: TaskStatus.IN_PROGRESS,
      });
    }

    // TODO: Send notification to volunteer about task assignment
    // await notificationService.notifyVolunteerAboutTaskAssignment(volunteerId, taskId);

    return {
      id: assignment.id,
      reportTaskId: assignment.reportTaskId,
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
    const task = await reportTaskRepository.findById(taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    if (!task.reportId) {
      throw new Error("Task has no associated report");
    }

    // Check if user can manage the report
    const canManage = await reportManagerService.canManageReport(
      task.reportId,
      removedBy,
    );
    if (!canManage) {
      throw new Error("Only reporter or managers can unassign tasks");
    }

    const assignment = await reportTaskRepository.findAssignment(
      taskId,
      volunteerId,
    );
    if (!assignment) {
      throw new Error("Volunteer is not assigned to this task");
    }

    await reportTaskRepository.removeAssignment(assignment.id);
  }

  /**
   * Get tasks assigned to a volunteer
   */
  async getMyAssignedTasks(volunteerId: string) {
    const assignments =
      await reportTaskRepository.findAssignmentsByVolunteerId(volunteerId);
    return assignments.map((a) => ({
      assignment: {
        id: a.id,
        reportTaskId: a.reportTaskId,
        volunteerId: a.volunteerId,
        createdAt: a.createdAt,
      },
      task: a.reportTask
        ? {
            id: a.reportTask.id,
            reportId: a.reportTask.reportId,
            title: a.reportTask.title,
            description: a.reportTask.description,
            status: a.reportTask.status,
            scheduledTime: a.reportTask.scheduledTime,
            createdBy: a.reportTask.createdBy,
            createdAt: a.reportTask.createdAt,
            report: a.reportTask.report,
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
    status: TaskStatus.IN_PROGRESS | TaskStatus.COMPLETED,
  ): Promise<TaskResponse> {
    const task = await reportTaskRepository.findById(taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    // Check if volunteer is assigned to this task
    const assignment = await reportTaskRepository.findAssignment(
      taskId,
      volunteerId,
    );
    if (!assignment) {
      throw new Error("You are not assigned to this task");
    }

    const updated = await reportTaskRepository.update(taskId, { status });
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
export const reportTaskService = new ReportTaskService();
