import { GreenPointFactory } from "./green-point.factory";
import { GreenPointService } from "./green-point.service";

const greenPointFactory = GreenPointFactory.createDefault();

export const greenPointService = new GreenPointService(greenPointFactory);

export { greenPointFactory };
