// doublexl: shared query for GET /api/v1/config (domains + signed-in principal).

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useAppConfig() {
	return useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity, // config rarely changes
	});
}

export function useIsAdmin(): boolean {
	const { data } = useAppConfig();
	return data?.principal.role === "admin";
}
