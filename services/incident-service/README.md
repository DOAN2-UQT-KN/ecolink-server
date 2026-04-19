# Incident Service

Microservice for handling incident reports, tasks, volunteers, and result submissions in the DA2 application.

## Features

### Workflows Implemented

1. **Report Creation Workflow**
   - Create reports with title, description, waste type, severity, location
   - Upload media files (images) for the report
   - TODO: AI service integration for automatic waste detection and verification

2. **Report Discovery Workflow**
   - Search/filter reports by name, status, waste type, severity
   - Sort by distance using PostGIS (requires user location)
   - Pagination support

3. **Volunteer Join Request Workflow**
   - Volunteers can request to join a report
   - View pending/approved/rejected requests

4. **Volunteer Approval Workflow**
   - Reporter can approve or reject volunteer join requests
   - One person per request approval

5. **Manager Assignment**
   - Reporter can assign managers to help manage the report
   - Managers can create tasks and submit results

6. **Task Execution Workflow**
   - Reporter/managers can create tasks for a report
   - Assign tasks to approved volunteers
   - Volunteers can update task status

7. **Report Result Submission Workflow**
   - Managers submit results with description and "AFTER" photos
   - Results are pending approval by default

8. **Reporter Result Approval Workflow**
   - Reporter approves/rejects submitted results
   - On approval: report status changes to "completed"
   - TODO: Integration with reward-service to add green points

## API Endpoints

### Reports

- `POST /api/v1/reports` - Create a report
- `GET /api/v1/reports/search` - Search reports with filters
- `GET /api/v1/reports/my` - Get current user's reports
- `GET /api/v1/reports/:id` - Get report by ID
- `GET /api/v1/reports/:id/detail` - Get report with full details
- `PUT /api/v1/reports/:id` - Update a report
- `DELETE /api/v1/reports/:id` - Delete a report (soft delete)

### Volunteers

- `POST /api/v1/volunteers/join-requests` - Create join request
- `GET /api/v1/volunteers/join-requests/my` - Get my join requests
- `GET /api/v1/volunteers/join-requests/:id` - Get join request by ID
- `POST /api/v1/volunteers/join-requests/:id/approve` - Approve join request
- `POST /api/v1/volunteers/join-requests/:id/reject` - Reject join request
- `DELETE /api/v1/volunteers/join-requests/:id` - Cancel join request
- `GET /api/v1/volunteers/reports/:reportId/join-requests` - Get report's join requests
- `GET /api/v1/volunteers/reports/:reportId/approved` - Get approved volunteers

### Managers

- `POST /api/v1/managers` - Assign a manager
- `GET /api/v1/managers/my` - Get reports I manage
- `GET /api/v1/managers/reports/:reportId` - Get managers for a report
- `DELETE /api/v1/managers/reports/:reportId/users/:userId` - Remove a manager

### Tasks

- `POST /api/v1/tasks` - Create a task
- `GET /api/v1/tasks/my` - Get my assigned tasks
- `GET /api/v1/tasks/reports/:reportId` - Get tasks for a report
- `GET /api/v1/tasks/:id` - Get task by ID
- `GET /api/v1/tasks/:id/detail` - Get task with assignments
- `PUT /api/v1/tasks/:id` - Update a task
- `DELETE /api/v1/tasks/:id` - Delete a task
- `POST /api/v1/tasks/:id/assign` - Assign volunteer to task
- `DELETE /api/v1/tasks/:id/volunteers/:volunteerId` - Unassign volunteer
- `PATCH /api/v1/tasks/:id/status` - Update task status (as volunteer)

### Results

- `POST /api/v1/results` - Submit a result
- `GET /api/v1/results/reports/:reportId` - Get results for a report
- `GET /api/v1/results/:id` - Get result by ID
- `GET /api/v1/results/:id/detail` - Get result with details
- `PUT /api/v1/results/:id` - Update a result
- `POST /api/v1/results/:id/approve` - Approve a result
- `POST /api/v1/results/:id/reject` - Reject a result

## Development

### Prerequisites

- Node.js 18+
- PostgreSQL with PostGIS extension
- npm

### Setup

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# Start development server
npm run dev
```

### Environment Variables

```env
PORT=3001
NODE_ENV=development
DATABASE_URL=postgresql://postgres:password@localhost:5432/incidentdb?schema=public
JWT_SECRET=your-secret-key
CORS_ORIGIN=*
AI_SERVICE_URL=http://ai-service:3004
REWARD_SERVICE_URL=http://reward-service:3002
NOTIFICATION_SERVICE_URL=http://notification-service:3003
```

## TODO

- [ ] Integrate with AI service for waste detection
- [ ] Integrate with reward service for green points
- [ ] Integrate with notification service for real-time updates
- [ ] Add file upload handling (currently expects URLs)
- [ ] Add rate limiting
- [ ] Add request logging
