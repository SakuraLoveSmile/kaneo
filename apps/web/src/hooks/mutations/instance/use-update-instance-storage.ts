import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type UpdatedInstanceStorageResponse,
  type UpdateInstanceStoragePayload,
  updateInstanceStorage,
} from "@/fetchers/instance/update-instance-storage";

export function useUpdateInstanceStorage() {
  const queryClient = useQueryClient();

  return useMutation<
    UpdatedInstanceStorageResponse,
    Error,
    UpdateInstanceStoragePayload
  >({
    mutationFn: (payload: UpdateInstanceStoragePayload) =>
      updateInstanceStorage(payload),
    onSuccess: (data) => {
      queryClient.setQueryData(["instance", "storage"], data);
      void queryClient.invalidateQueries({
        queryKey: ["instance", "storage"],
      });
    },
  });
}

export default useUpdateInstanceStorage;
