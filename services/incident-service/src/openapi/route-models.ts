import type { OpenapiRouteModels } from "@da2/express-swagger";

export const OPENAPI_ROUTE_MODELS: OpenapiRouteModels = {
  "POST /api/v1/reports": {
    requestBody: "CreateReportRequest",
    responseData: "ReportOneEnvelopeData",
  },
  "GET /api/v1/reports/search": {
    query: "ReportSearchQuery",
    responseData: "PaginatedReportsResponse",
  },
  "GET /api/v1/reports/my": {
    query: "ReportSearchQuery",
    responseData: "ReportsListEnvelopeData",
  },
  "GET /api/v1/reports/:id/background-jobs/status": {
    responseData: "BackgroundJobsEnvelopeData",
  },
  "GET /api/v1/reports/:id": {
    responseData: "ReportDetailEnvelopeData",
  },
  "PUT /api/v1/reports/:id": {
    requestBody: "UpdateReportRequest",
    responseData: "ReportOneEnvelopeData",
  },
  "POST /api/v1/reports/:id/media": {
    requestBody: "AddReportImagesRequest",
    responseData: "ReportOneEnvelopeData",
  },
  "DELETE /api/v1/reports/:id/media/:mediaFileId": {
    responseData: "ReportOneEnvelopeData",
  },
  "PUT /api/v1/reports/:id/verify": {
    responseData: "ReportOneEnvelopeData",
  },
  "PUT /api/v1/reports/:id/ban": {
    responseData: "ReportOneEnvelopeData",
  },
  "DELETE /api/v1/reports/:id": {
    omitData: true,
  },

  "POST /api/v1/campaigns": {
    requestBody: "CreateCampaignRequest",
    responseData: "CampaignOneEnvelopeData",
  },
  "GET /api/v1/campaigns": {
    query: "CampaignListQuery",
    responseData: "PaginatedCampaignsEnvelopeData",
  },
  "GET /api/v1/campaigns/tasks/my-assigned": {
    responseData: "TasksListEnvelopeData",
  },
  "GET /api/v1/campaigns/tasks/:taskId": {
    responseData: "TaskOneEnvelopeData",
  },
  "PUT /api/v1/campaigns/tasks/:taskId": {
    requestBody: "UpdateCampaignTaskBody",
    responseData: "TaskOneEnvelopeData",
  },
  "DELETE /api/v1/campaigns/tasks/:taskId": {
    omitData: true,
  },
  "POST /api/v1/campaigns/tasks/:taskId/assign": {
    requestBody: "AssignVolunteerBody",
    responseData: "TaskAssignmentEnvelopeData",
  },
  "POST /api/v1/campaigns/tasks/:taskId/unassign": {
    requestBody: "AssignVolunteerBody",
    omitData: true,
  },
  "PUT /api/v1/campaigns/tasks/:taskId/status": {
    requestBody: "TaskStatusUpdateBody",
    responseData: "TaskOneEnvelopeData",
  },
  "GET /api/v1/campaigns/:id": {
    responseData: "CampaignOneEnvelopeData",
  },
  "PUT /api/v1/campaigns/:id/verify": {
    responseData: "CampaignOneEnvelopeData",
  },
  "PUT /api/v1/campaigns/:id": {
    requestBody: "UpdateCampaignRequest",
    responseData: "CampaignOneEnvelopeData",
  },
  "DELETE /api/v1/campaigns/:id": {
    omitData: true,
  },
  "POST /api/v1/campaigns/:id/add-managers": {
    requestBody: "AddCampaignManagersRequest",
    responseData: "ManagersListEnvelopeData",
  },
  "POST /api/v1/campaigns/:id/remove-manager": {
    requestBody: "RemoveCampaignManagerBody",
    omitData: true,
  },
  "GET /api/v1/campaigns/:id/managers": {
    query: "CampaignManagersListQuery",
    responseData: "PaginatedManagersEnvelopeData",
  },
  "POST /api/v1/campaigns/:id/tasks": {
    requestBody: "CreateCampaignTaskBody",
    responseData: "TaskOneEnvelopeData",
  },
  "GET /api/v1/campaigns/:id/tasks": {
    responseData: "TasksListEnvelopeData",
  },
  "POST /api/v1/campaigns/volunteers/join-requests": {
    requestBody: "CreateJoinRequestBody",
    responseData: "JoinRequestOneEnvelopeData",
  },
  "GET /api/v1/campaigns/volunteers/join-requests": {
    query: "GetJoinRequestsQuery",
    responseData: "PaginatedJoinRequestsEnvelopeData",
  },
  "GET /api/v1/campaigns/volunteers/join-requests/my": {
    query: "MyJoinRequestsQuery",
    responseData: "PaginatedJoinRequestsEnvelopeData",
  },
  "PUT /api/v1/campaigns/volunteers/join-requests/process": {
    requestBody: "ProcessJoinRequestBody",
    responseData: "JoinRequestOneEnvelopeData",
  },
  "DELETE /api/v1/campaigns/volunteers/join-requests/cancel": {
    requestBody: "CancelJoinRequestBody",
    omitData: true,
  },
  "GET /api/v1/campaigns/volunteers/approved": {
    query: "GetApprovedVolunteersQuery",
    responseData: "PaginatedVolunteersEnvelopeData",
  },
  "POST /api/v1/campaigns/:id/submissions": {
    requestBody: "CreateCampaignSubmissionBody",
    responseData: "SubmissionOneEnvelopeData",
  },
  "GET /api/v1/campaigns/:id/submissions": {
    query: "CampaignSubmissionsListQuery",
    responseData: "PaginatedSubmissionsEnvelopeData",
  },
  "GET /api/v1/campaigns/:id/submissions/current-results": {
    responseData: "ResultsListEnvelopeData",
  },
  "GET /api/v1/campaigns/submissions/:submissionId": {
    responseData: "SubmissionOneEnvelopeData",
  },
  "POST /api/v1/campaigns/submissions/:submissionId/results": {
    requestBody: "AddSubmissionResultBody",
    responseData: "ResultOneEnvelopeData",
  },
  "PUT /api/v1/campaigns/submissions/:submissionId/process": {
    requestBody: "ProcessSubmissionBody",
    responseData: "SubmissionOneEnvelopeData",
  },

  "POST /incident/votes/upvote": {
    requestBody: "VoteActionBody",
    responseData: "VoteActionEnvelopeData",
  },
  "POST /incident/votes/downvote": {
    requestBody: "VoteActionBody",
    responseData: "VoteActionEnvelopeData",
  },

  "POST /api/v1/saved-resources/save": {
    requestBody: "SaveResourceBody",
    responseData: "SaveResourceEnvelopeData",
  },
};
