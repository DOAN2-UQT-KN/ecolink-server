import { Router } from "express";
import { reportController } from "./report.controller";
import { authenticate } from "../../middleware/auth.middleware";

const router = Router();

/**
 * @route   POST /api/v1/reports
 * @desc    Create a new report
 * @access  Private
 */
router.post("/", authenticate, reportController.createReport);

/**
 * @route   GET /api/v1/reports/search
 * @desc    Search and discover reports with filters and sorting
 * @access  Private
 */
router.get("/search", authenticate, reportController.searchReports);

/**
 * @route   GET /api/v1/reports/my
 * @desc    Get current user's reports
 * @access  Private
 */
router.get("/my", authenticate, reportController.getMyReports);

/**
 * @route   GET /api/v1/reports/:id
 * @desc    Get report with full details
 * @access  Private
 */
router.get("/:id", authenticate, reportController.getReportDetail);

/**
 * @route   PUT /api/v1/reports/:id
 * @desc    Update a report
 * @access  Private (Report owner only; admins cannot edit)
 */
router.put("/:id", authenticate, reportController.updateReport);

/**
 * @route   POST /api/v1/reports/:id/media
 * @desc    Add images to a report
 * @access  Private (Report owner only; admins cannot edit)
 */
router.post("/:id/media", authenticate, reportController.addReportImages);

/**
 * @route   DELETE /api/v1/reports/:id/media/:mediaFileId
 * @desc    Soft-delete a report media file
 * @access  Private (Report owner only; admins cannot edit)
 */
router.delete(
  "/:id/media/:mediaFileId",
  authenticate,
  reportController.deleteReportMediaFile,
);

/**
 * @route   PUT /api/v1/reports/:id/ban
 * @desc    Ban a report (moderation)
 * @access  Private (Admin only)
 */
router.put("/:id/ban", authenticate, reportController.adminBanReport);



/**
 * @route   DELETE /api/v1/reports/:id
 * @desc    Delete a report (soft delete)
 * @access  Private (Report owner only; admins cannot delete — use ban)
 */
router.delete("/:id", authenticate, reportController.deleteReport);

// =====================
// Manager Routes
// =====================

/**
 * @route   POST /api/v1/reports/:id/add-managers
 * @desc    Add multiple managers to a report
 * @access  Private (Reporter only)
 */
router.post("/:id/add-managers", authenticate, reportController.addManagers);

/**
 * @route   POST /api/v1/reports/:id/remove-manager
 * @desc    Remove a manager from a report
 * @access  Private (Reporter only)
 */
router.post(
  "/:id/remove-manager",
  authenticate,
  reportController.removeManager,
);

/**
 * @route   GET /api/v1/reports/:id/managers
 * @desc    Get all managers for a report
 * @access  Private
 */
router.get("/:id/managers", authenticate, reportController.getReportManagers);

// =====================
// Task Routes
// =====================

/**
 * @route   POST /api/v1/reports/tasks
 * @desc    Create a new task for a report
 * @access  Private (Reporter or Managers only)
 * @body    { reportId, title, description?, scheduledTime? }
 */
router.post("/tasks", authenticate, reportController.createTask);

/**
 * @route   POST /api/v1/reports/tasks/get
 * @desc    Get all tasks for a report
 * @access  Private
 * @body    { reportId }
 */
router.post("/tasks/get", authenticate, reportController.getReportTasks);

/**
 * @route   POST /api/v1/reports/tasks/detail
 * @desc    Get task by ID with full details
 * @access  Private
 * @body    { taskId }
 */
router.post("/tasks/detail", authenticate, reportController.getTaskById);

/**
 * @route   PUT /api/v1/reports/tasks/update
 * @desc    Update a task
 * @access  Private (Reporter or Managers only)
 * @body    { taskId, title?, description?, status?, scheduledTime? }
 */
router.put("/tasks/update", authenticate, reportController.updateTask);

/**
 * @route   DELETE /api/v1/reports/tasks/delete
 * @desc    Delete a task
 * @access  Private (Reporter or Managers only)
 * @body    { taskId }
 */
router.delete("/tasks/delete", authenticate, reportController.deleteTask);

/**
 * @route   POST /api/v1/reports/tasks/assign
 * @desc    Assign a task to a volunteer
 * @access  Private (Reporter or Managers only)
 * @body    { taskId, volunteerId }
 */
router.post("/tasks/assign", authenticate, reportController.assignTask);

/**
 * @route   POST /api/v1/reports/tasks/unassign
 * @desc    Unassign a volunteer from a task
 * @access  Private (Reporter or Managers only)
 * @body    { taskId, volunteerId }
 */
router.post("/tasks/unassign", authenticate, reportController.unassignTask);

/**
 * @route   GET /api/v1/reports/tasks/my-assigned
 * @desc    Get all tasks assigned to current user (volunteer)
 * @access  Private
 */
router.get(
  "/tasks/my-assigned",
  authenticate,
  reportController.getMyAssignedTasks,
);

/**
 * @route   PUT /api/v1/reports/tasks/status
 * @desc    Update task status (by assigned volunteer)
 * @access  Private (Assigned volunteers only)
 * @body    { taskId, status }
 */
router.put("/tasks/status", authenticate, reportController.updateTaskStatus);

// Results have moved to campaign level — see /api/v1/campaigns/:id/submissions

export default router;

