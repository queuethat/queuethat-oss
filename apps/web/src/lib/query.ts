import { QueryClient } from '@tanstack/react-query';

/**
 * The single QueryClient. Live screens keep data fresh through `useLiveQuery` (L1, #40),
 * which invalidates these queries on realtime signals and polls as a fallback.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 2,
      refetchOnWindowFocus: true,
    },
  },
});
