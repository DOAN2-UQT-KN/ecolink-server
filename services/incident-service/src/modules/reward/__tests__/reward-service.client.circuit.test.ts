import axios from "axios";
import { RewardServiceClient } from "../reward-service.client";
import {
  getHttpCircuit,
  HTTP_CIRCUIT_REWARD,
  resetHttpCircuitsForTests,
} from "../../../resilience/http-circuit";

jest.mock("axios");

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("RewardServiceClient HTTP circuit breaker", () => {
  const get = jest.fn();

  beforeEach(() => {
    resetHttpCircuitsForTests();
    jest.clearAllMocks();
    process.env.REWARD_SERVICE_URL = "http://reward.test";
    process.env.INTERNAL_REWARD_API_KEY = "test-key";
    process.env.HTTP_BREAKER_FAILURE_THRESHOLD = "3";
    process.env.HTTP_BREAKER_OPEN_MS = "30000";
    process.env.HTTP_BREAKER_SUCCESS_THRESHOLD = "2";
    process.env.NODE_ENV = "test";

    mockedAxios.create.mockReturnValue({ get } as never);
    mockedAxios.isAxiosError.mockReturnValue(false);
  });

  it("opens circuit after consecutive HTTP failures and stops calling axios", async () => {
    get.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const client = new RewardServiceClient(getHttpCircuit(HTTP_CIRCUIT_REWARD));

    expect(await client.getCampaignCompletionPoints()).toBeNull();
    expect(await client.getCampaignCompletionPoints()).toBeNull();
    expect(await client.getCampaignCompletionPoints()).toBeNull();
    expect(client.getCircuitState()).toBe("OPEN");
    expect(get).toHaveBeenCalledTimes(3);

    expect(await client.getCampaignCompletionPoints()).toBeNull();
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("keeps circuit CLOSED and returns the points when HTTP succeeds", async () => {
    get.mockResolvedValue({ data: { success: true, data: { campaignCompletionPoints: 20 } } });
    const client = new RewardServiceClient(getHttpCircuit(HTTP_CIRCUIT_REWARD));

    expect(await client.getCampaignCompletionPoints()).toBe(20);
    expect(get).toHaveBeenCalledWith("/internal/v1/point-rules/campaign-completion");
    expect(client.getCircuitState()).toBe("CLOSED");
  });

  it("treats 404 (no active rules) as null without tripping the circuit", async () => {
    mockedAxios.isAxiosError.mockReturnValue(true);
    get.mockRejectedValue({ response: { status: 404 } });
    const client = new RewardServiceClient(getHttpCircuit(HTTP_CIRCUIT_REWARD));

    for (let i = 0; i < 4; i++) expect(await client.getCampaignCompletionPoints()).toBeNull();
    expect(client.getCircuitState()).toBe("CLOSED");
    expect(get).toHaveBeenCalledTimes(4);
  });
});
