import axios from "axios";
import { RewardServiceClient } from "../reward-service.client";
import {
  getHttpCircuit,
  HTTP_CIRCUIT_REWARD,
  resetHttpCircuitsForTests,
} from "../../../resilience/http-circuit";

jest.mock("axios");

const mockedAxios = axios as jest.Mocked<typeof axios>;

const code = (c: string) =>
  expect.objectContaining({ statusResponse: expect.objectContaining({ code: c }) });

describe("RewardServiceClient difficulty lookup", () => {
  const get = jest.fn();
  const tier = { id: "d1", level: 1, name: "Easy", maxVolunteers: 10, greenPoints: 5 };

  beforeEach(() => {
    resetHttpCircuitsForTests();
    jest.clearAllMocks();
    process.env.REWARD_SERVICE_URL = "http://reward.test";
    process.env.INTERNAL_REWARD_API_KEY = "test-key";
    process.env.HTTP_BREAKER_FAILURE_THRESHOLD = "2";
    process.env.NODE_ENV = "test";
    mockedAxios.create.mockReturnValue({ get } as never);
    mockedAxios.isAxiosError.mockImplementation(
      (e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError),
    );
  });

  const client = () => new RewardServiceClient(getHttpCircuit(HTTP_CIRCUIT_REWARD));

  it("returns the tier when it exists", async () => {
    get.mockResolvedValue({ data: { success: true, data: { difficulty: tier } } });
    await expect(client().getDifficultyByLevelStrict(1)).resolves.toMatchObject({ level: 1 });
  });

  it("404 means no such level: null, and the circuit stays closed", async () => {
    get.mockRejectedValue({ isAxiosError: true, response: { status: 404 } });
    const c = client();
    for (let i = 0; i < 3; i++) {
      await expect(c.getDifficultyByLevelStrict(9)).resolves.toBeNull();
    }
    expect(c.getCircuitState()).toBe("CLOSED");
  });

  it("an outage throws 503 in the strict lookup, null in the display lookup", async () => {
    get.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const c = client();
    await expect(c.getDifficultyByLevelStrict(1)).rejects.toEqual(
      code("REWARD_SERVICE_UNAVAILABLE"),
    );
    await expect(c.getDifficultyByLevel(1)).resolves.toBeNull();
  });

  it("a 500 or missing configuration is an outage too", async () => {
    get.mockRejectedValue({ isAxiosError: true, response: { status: 500 } });
    await expect(client().getDifficultyByLevelStrict(1)).rejects.toEqual(
      code("REWARD_SERVICE_UNAVAILABLE"),
    );
    delete process.env.REWARD_SERVICE_URL;
    await expect(client().getDifficultyByLevelStrict(1)).rejects.toEqual(
      code("REWARD_SERVICE_UNAVAILABLE"),
    );
  });
});
