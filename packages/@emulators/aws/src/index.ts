export const serviceName = "aws";
export const serviceLabel = "AWS cloud services";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
