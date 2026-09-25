/**
 * OTP và submission token là cổng chặn spam duy nhất của form nộp đơn công khai
 * (không có đăng nhập), nên các nhánh sai mã / hết hạn / quá số lần thử được kiểm
 * kỹ hơn nhánh thành công.
 */

const createMock = jest.fn();
const expireActiveForMock = jest.fn();
const findActiveMock = jest.fn();
const findActiveByHashMock = jest.fn();
const incrementAttemptsMock = jest.fn();
const markUsedMock = jest.fn();
const countIssuedSinceMock = jest.fn();
const deleteByIdMock = jest.fn();
const sendOtpEmailMock = jest.fn();

jest.mock("../organization-application-otp.repository", () => ({
  OtpPurpose: { OTP: "OTP", SUBMISSION: "SUBMISSION", TRACKING: "TRACKING" },
  organizationApplicationOtpRepository: {
    create: (...a: unknown[]) => createMock(...a),
    expireActiveFor: (...a: unknown[]) => expireActiveForMock(...a),
    findActive: (...a: unknown[]) => findActiveMock(...a),
    findActiveByHash: (...a: unknown[]) => findActiveByHashMock(...a),
    incrementAttempts: (...a: unknown[]) => incrementAttemptsMock(...a),
    markUsed: (...a: unknown[]) => markUsedMock(...a),
    countIssuedSince: (...a: unknown[]) => countIssuedSinceMock(...a),
    deleteById: (...a: unknown[]) => deleteByIdMock(...a),
  },
}));

jest.mock("../organization-application-notify.client", () => ({
  enqueueApplicationOtpEmail: (...a: unknown[]) => sendOtpEmailMock(...a),
}));

import { organizationApplicationOtpService } from "../organization-application-otp.service";
import { HttpError } from "../../../constants/http-status";
import { hashOpaqueToken } from "../../../utils/token-hash";

describe("OrganizationApplicationOtpService", () => {
  beforeEach(() => {
    countIssuedSinceMock.mockResolvedValue(0);
    expireActiveForMock.mockResolvedValue(undefined);
    createMock.mockResolvedValue({ id: "otp-1" });
    deleteByIdMock.mockResolvedValue(undefined);
    markUsedMock.mockResolvedValue(undefined);
    incrementAttemptsMock.mockResolvedValue(undefined);
    sendOtpEmailMock.mockResolvedValue(undefined);
  });

  describe("requestOtp", () => {
    it("chuẩn hoá email, gửi mã mới 6 chữ số rồi mới huỷ mã cũ", async () => {
      await organizationApplicationOtpService.requestOtp("  CLB@UIT.EDU.VN ");

      // Huỷ mã cũ chỉ xảy ra SAU khi gửi thành công, và chừa lại mã vừa phát.
      expect(expireActiveForMock).toHaveBeenCalledWith(
        "clb@uit.edu.vn",
        "OTP",
        "otp-1",
      );
      const sent = sendOtpEmailMock.mock.calls[0][0];
      expect(sent.toEmail).toBe("clb@uit.edu.vn");
      expect(sent.otp).toMatch(/^\d{6}$/);
      // Chỉ hash được lưu, không bao giờ là mã thô.
      expect(createMock.mock.calls[0][0].codeHash).toBe(
        hashOpaqueToken(sent.otp),
      );
    });

    it("chặn khi vượt hạn mức mã / email / giờ", async () => {
      countIssuedSinceMock.mockResolvedValue(3);

      await expect(
        organizationApplicationOtpService.requestOtp("clb@uit.edu.vn"),
      ).rejects.toMatchObject({ statusResponse: { status: 429 } });
      expect(createMock).not.toHaveBeenCalled();
    });

    describe("cửa thoát cho dev", () => {
      afterEach(() => {
        delete process.env.APPLICATION_RATE_LIMIT_DISABLED;
        process.env.NODE_ENV = "test";
      });

      it("bật cờ ở môi trường dev thì bỏ qua hạn mức, không còn đếm DB", async () => {
        process.env.NODE_ENV = "development";
        process.env.APPLICATION_RATE_LIMIT_DISABLED = "true";
        countIssuedSinceMock.mockResolvedValue(999);

        await expect(
          organizationApplicationOtpService.requestOtp("clb@uit.edu.vn"),
        ).resolves.toMatchObject({ expiresAt: expect.any(Date) });
        expect(countIssuedSinceMock).not.toHaveBeenCalled();
      });

      it("ở production thì cờ bị bỏ qua, hạn mức vẫn chặn", async () => {
        process.env.NODE_ENV = "production";
        process.env.APPLICATION_RATE_LIMIT_DISABLED = "true";
        countIssuedSinceMock.mockResolvedValue(3);

        await expect(
          organizationApplicationOtpService.requestOtp("clb@uit.edu.vn"),
        ).rejects.toMatchObject({ statusResponse: { status: 429 } });
      });

      it("không bật cờ thì vẫn chặn như thường", async () => {
        process.env.NODE_ENV = "development";
        countIssuedSinceMock.mockResolvedValue(3);

        await expect(
          organizationApplicationOtpService.requestOtp("clb@uit.edu.vn"),
        ).rejects.toMatchObject({ statusResponse: { status: 429 } });
      });
    });

    it("báo lỗi thay vì im lặng khi không gửi được email", async () => {
      sendOtpEmailMock.mockRejectedValue(new Error("smtp down"));

      await expect(
        organizationApplicationOtpService.requestOtp("clb@uit.edu.vn"),
      ).rejects.toMatchObject({ statusResponse: { status: 503 } });
    });

    it("gửi hỏng thì xoá mã vừa ghi, không đốt quota 3 mã/giờ", async () => {
      sendOtpEmailMock.mockRejectedValue(new Error("smtp down"));

      await expect(
        organizationApplicationOtpService.requestOtp("clb@uit.edu.vn"),
      ).rejects.toBeInstanceOf(HttpError);

      expect(deleteByIdMock).toHaveBeenCalledWith("otp-1");
    });

    it("gửi hỏng thì không đụng tới mã cũ còn hiệu lực trong hộp thư", async () => {
      sendOtpEmailMock.mockRejectedValue(new Error("smtp down"));

      await expect(
        organizationApplicationOtpService.requestOtp("clb@uit.edu.vn"),
      ).rejects.toBeInstanceOf(HttpError);

      expect(expireActiveForMock).not.toHaveBeenCalled();
    });

    it("xoá dọn cũng hỏng thì vẫn trả 503 chứ không ném lỗi khác", async () => {
      sendOtpEmailMock.mockRejectedValue(new Error("smtp down"));
      deleteByIdMock.mockRejectedValue(new Error("db gone"));

      await expect(
        organizationApplicationOtpService.requestOtp("clb@uit.edu.vn"),
      ).rejects.toMatchObject({ statusResponse: { status: 503 } });
    });
  });

  describe("verifyOtp", () => {
    const activeRecord = (otp: string, attempts = 0) => ({
      id: "otp-1",
      codeHash: hashOpaqueToken(otp),
      attempts,
    });

    it("đổi mã đúng lấy submission token và đánh dấu mã đã dùng", async () => {
      findActiveMock.mockResolvedValue(activeRecord("123456"));

      const result = await organizationApplicationOtpService.verifyOtp(
        "clb@uit.edu.vn",
        "123456",
      );

      expect(markUsedMock).toHaveBeenCalledWith("otp-1");
      expect(result.submissionToken).toEqual(expect.any(String));
      // Token cũng chỉ lưu hash.
      const submissionRow = createMock.mock.calls.at(-1)?.[0];
      expect(submissionRow.purpose).toBe("SUBMISSION");
      expect(submissionRow.codeHash).toBe(
        hashOpaqueToken(result.submissionToken),
      );
    });

    it("mã sai thì tăng attempts và không phát token", async () => {
      findActiveMock.mockResolvedValue(activeRecord("123456"));

      await expect(
        organizationApplicationOtpService.verifyOtp("clb@uit.edu.vn", "000000"),
      ).rejects.toBeInstanceOf(HttpError);
      expect(incrementAttemptsMock).toHaveBeenCalledWith("otp-1");
      expect(createMock).not.toHaveBeenCalled();
    });

    it("không còn mã hiệu lực (hết hạn hoặc đã dùng) thì từ chối", async () => {
      findActiveMock.mockResolvedValue(null);

      await expect(
        organizationApplicationOtpService.verifyOtp("clb@uit.edu.vn", "123456"),
      ).rejects.toMatchObject({ statusResponse: { code: "OTP_INVALID" } });
    });

    it("quá số lần thử thì đốt mã, kể cả khi lần này nhập đúng", async () => {
      findActiveMock.mockResolvedValue(activeRecord("123456", 5));

      await expect(
        organizationApplicationOtpService.verifyOtp("clb@uit.edu.vn", "123456"),
      ).rejects.toMatchObject({
        statusResponse: { code: "OTP_TOO_MANY_ATTEMPTS" },
      });
      expect(markUsedMock).toHaveBeenCalledWith("otp-1");
    });
  });

  describe("submission token", () => {
    it("resolve không đốt token, consume thì đốt", async () => {
      findActiveByHashMock.mockResolvedValue({
        id: "sub-1",
        email: "clb@uit.edu.vn",
      });

      await expect(
        organizationApplicationOtpService.resolveSubmissionToken("tok"),
      ).resolves.toBe("clb@uit.edu.vn");
      expect(markUsedMock).not.toHaveBeenCalled();

      await organizationApplicationOtpService.consumeSubmissionToken("tok");
      expect(markUsedMock).toHaveBeenCalledWith("sub-1");
    });

    it("token không hợp lệ trả 401", async () => {
      findActiveByHashMock.mockResolvedValue(null);

      await expect(
        organizationApplicationOtpService.resolveSubmissionToken("nope"),
      ).rejects.toMatchObject({ statusResponse: { status: 401 } });
    });
  });
});
