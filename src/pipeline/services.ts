import services from "../../studio/services.json";

export type Services = typeof services;
export const defaultServices: Services = services;

export type Fetch = typeof fetch;

export class ServiceError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    body: string,
  ) {
    super(`${service} request failed (${status}): ${body.slice(0, 500)}`);
  }
}

export async function checkedJson<T>(service: string, res: Response): Promise<T> {
  if (!res.ok) throw new ServiceError(service, res.status, await res.text());
  return (await res.json()) as T;
}
