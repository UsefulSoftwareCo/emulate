export const serviceName = "mongoatlas";
export const serviceLabel = "MongoDB Atlas Admin API and Data API";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
