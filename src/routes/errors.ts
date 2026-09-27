export interface ErrorBody {
  detail: string;
}

export function errorBody(detail: string): ErrorBody {
  return { detail };
}
