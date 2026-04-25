import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting incident-service seed...");

  // organizations
  await prisma.organization.upsert({
    where: { id: "44444444-4444-4444-a444-444444444401" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444401",
      name: "Eco Volunteers",
      description: "Seeded organization for integration testing",
      logoUrl: "https://example.com/logo.png",
      backgroundUrl: "https://example.com/bg.png",
      contactEmail: "contact@ecovolunteers.local",
      isEmailVerified: true,
      status: 1,
      ownerId: "11111111-1111-1111-1111-111111111141",
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Organizations created");

  // campaigns
  await prisma.campaign.upsert({
    where: { id: "44444444-4444-4444-a444-444444444411" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444411",
      title: "Weekend River Cleanup",
      description: "Seed campaign",
      status: 1,
      difficulty: 2,
      organizationId: "44444444-4444-4444-a444-444444444401",
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Campaigns created");

  // reports
  await prisma.report.upsert({
    where: { id: "44444444-4444-4444-a444-444444444451" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444451",
      campaignId: "44444444-4444-4444-a444-444444444411",
      userId: "11111111-1111-1111-1111-111111111142",
      title: "Trash near river bank",
      description: "Plastic and cans scattered around the river",
      wasteType: "PLASTIC",
      severityLevel: 3,
      latitude: 10.7769,
      longitude: 106.7009,
      detailAddress: "District 1, Ho Chi Minh City",
      status: 10,
      isVerify: true,
      aiVerified: true,
      createdBy: "11111111-1111-1111-1111-111111111142",
      updatedBy: "11111111-1111-1111-1111-111111111142",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Reports created");

  // media
  await prisma.media.upsert({
    where: { id: "44444444-4444-4444-a444-444444444461" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444461",
      url: "https://example.com/report-1.jpg",
      type: "IMAGE",
      createdBy: "11111111-1111-1111-1111-111111111142",
      updatedBy: "11111111-1111-1111-1111-111111111142",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  await prisma.media.upsert({
    where: { id: "44444444-4444-4444-a444-444444444462" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444462",
      url: "https://example.com/campaign-result-1.jpg",
      type: "IMAGE",
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Media created");

  // report_media_files
  await prisma.reportMediaFile.upsert({
    where: { id: "44444444-4444-4444-a444-444444444471" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444471",
      reportId: "44444444-4444-4444-a444-444444444451",
      mediaId: "44444444-4444-4444-a444-444444444461",
      uploadedBy: "11111111-1111-1111-1111-111111111142",
      createdBy: "11111111-1111-1111-1111-111111111142",
      updatedBy: "11111111-1111-1111-1111-111111111142",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Report media files created");

  // report_issues
  await prisma.reportIssue.upsert({
    where: { id: "44444444-4444-4444-a444-444444444481" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444481",
      reportId: "44444444-4444-4444-a444-444444444451",
      reporterId: "11111111-1111-1111-1111-111111111141",
      issueType: "DUPLICATE",
      description: "Potential duplicate report in same area",
      mediaFileUrl: "https://example.com/issue-proof.jpg",
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Report issues created");

  // campaign_managers
  await prisma.campaignManager.upsert({
    where: {
      campaignId_userId: {
        campaignId: "44444444-4444-4444-a444-444444444411",
        userId: "11111111-1111-1111-1111-111111111141",
      },
    },
    update: {},
    create: {
      campaignId: "44444444-4444-4444-a444-444444444411",
      userId: "11111111-1111-1111-1111-111111111141",
      assignedBy: "11111111-1111-1111-1111-111111111141",
      assignedAt: new Date("2026-01-01T00:00:00Z"),
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Campaign managers created");

  // campaign_joining_requests
  await prisma.campaignJoiningRequest.upsert({
    where: { id: "44444444-4444-4444-a444-444444444491" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444491",
      campaignId: "44444444-4444-4444-a444-444444444411",
      volunteerId: "11111111-1111-1111-1111-111111111142",
      status: 13,
      createdBy: "11111111-1111-1111-1111-111111111142",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Campaign joining requests created");

  // campaign_tasks
  await prisma.campaignTask.upsert({
    where: { id: "44444444-4444-4444-a444-444444444501" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444501",
      campaignId: "44444444-4444-4444-a444-444444444411",
      title: "Collect plastics",
      description: "Gather plastics around river edge",
      status: 21,
      scheduledTime: new Date("2026-01-03T08:00:00Z"),
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Campaign tasks created");

  // campaign_task_assignments
  await prisma.campaignTaskAssignment.upsert({
    where: { id: "44444444-4444-4444-a444-444444444511" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444511",
      campaignTaskId: "44444444-4444-4444-a444-444444444501",
      volunteerId: "11111111-1111-1111-1111-111111111142",
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Campaign task assignments created");

  // campaign_submissions
  await prisma.campaignSubmission.upsert({
    where: { id: "44444444-4444-4444-a444-444444444521" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444521",
      campaignId: "44444444-4444-4444-a444-444444444411",
      submittedBy: "11111111-1111-1111-1111-111111111141",
      title: "Week 1 submission",
      description: "Initial cleanup result submission",
      status: 10,
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Campaign submissions created");

  // campaign_results
  await prisma.campaignResult.upsert({
    where: { id: "44444444-4444-4444-a444-444444444531" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444531",
      campaignId: "44444444-4444-4444-a444-444444444411",
      campaignSubmissionId: "44444444-4444-4444-a444-444444444521",
      title: "Removed 20kg waste",
      description: "Collected and sorted waste from river bank",
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Campaign results created");

  // campaign_result_files
  await prisma.campaignResultFile.upsert({
    where: { id: "44444444-4444-4444-a444-444444444541" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444541",
      campaignResultId: "44444444-4444-4444-a444-444444444531",
      mediaId: "44444444-4444-4444-a444-444444444462",
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Campaign result files created");

  // ai_analysis_logs
  await prisma.aiAnalysisLog.upsert({
    where: { id: "44444444-4444-4444-a444-444444444551" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444551",
      reportId: "44444444-4444-4444-a444-444444444451",
      reportMediaFileId: "44444444-4444-4444-a444-444444444471",
      mediaId: "44444444-4444-4444-a444-444444444461",
      detections: 7,
      createdBy: "11111111-1111-1111-1111-111111111142",
      updatedBy: "11111111-1111-1111-1111-111111111142",
      processedAt: new Date("2026-01-01T00:10:00Z"),
      createdAt: new Date("2026-01-01T00:10:00Z"),
      updatedAt: new Date("2026-01-01T00:10:00Z"),
    },
  });
  console.log("✅ AI analysis logs created");

  // background_jobs
  await prisma.backgroundJob.upsert({
    where: { id: "44444444-4444-4444-a444-444444444561" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444561",
      jobType: "REPORT_AI_ANALYSIS",
      payload: { reportId: "44444444-4444-4444-a444-444444444451" },
      status: 10,
      attempts: 1,
      maxAttempts: 5,
      runAfter: new Date("2026-01-01T00:00:00Z"),
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      processedAt: new Date("2026-01-01T00:15:00Z"),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:15:00Z"),
    },
  });
  console.log("✅ Background jobs created");

  // votes
  await prisma.vote.upsert({
    where: {
      userId_resourceType_resourceId: {
        userId: "11111111-1111-1111-1111-111111111142",
        resourceType: "REPORT",
        resourceId: "44444444-4444-4444-a444-444444444451",
      },
    },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444571",
      userId: "11111111-1111-1111-1111-111111111142",
      value: 1,
      resourceType: "REPORT",
      resourceId: "44444444-4444-4444-a444-444444444451",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Votes created");

  // saved_resources
  await prisma.savedResource.upsert({
    where: {
      userId_resourceType_resourceId: {
        userId: "11111111-1111-1111-1111-111111111142",
        resourceType: "CAMPAIGN",
        resourceId: "44444444-4444-4444-a444-444444444411",
      },
    },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444581",
      userId: "11111111-1111-1111-1111-111111111142",
      resourceId: "44444444-4444-4444-a444-444444444411",
      resourceType: "CAMPAIGN",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Saved resources created");

  // organization_members
  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId: "44444444-4444-4444-a444-444444444401",
        userId: "11111111-1111-1111-1111-111111111142",
      },
    },
    update: {},
    create: {
      organizationId: "44444444-4444-4444-a444-444444444401",
      userId: "11111111-1111-1111-1111-111111111142",
      createdBy: "11111111-1111-1111-1111-111111111141",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Organization members created");

  // organization_joining_requests
  await prisma.organizationJoiningRequest.upsert({
    where: { id: "44444444-4444-4444-a444-444444444591" },
    update: {},
    create: {
      id: "44444444-4444-4444-a444-444444444591",
      organizationId: "44444444-4444-4444-a444-444444444401",
      requesterId: "11111111-1111-1111-1111-111111111142",
      status: 13,
      createdBy: "11111111-1111-1111-1111-111111111142",
      updatedBy: "11111111-1111-1111-1111-111111111141",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  console.log("✅ Organization joining requests created");

  console.log("✨ Incident-service seed completed successfully!");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
