import { useQuery } from "@tanstack/react-query";
import { getInstanceStorage } from "@/fetchers/instance/get-instance-storage";

export function useGetInstanceStorage() {
  return useQuery({
    queryKey: ["instance", "storage"],
    queryFn: getInstanceStorage,
  });
}

export default useGetInstanceStorage;
