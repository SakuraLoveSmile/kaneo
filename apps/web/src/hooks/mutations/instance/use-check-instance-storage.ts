import { useMutation } from "@tanstack/react-query";
import { checkInstanceStorage } from "@/fetchers/instance/check-instance-storage";

export function useCheckInstanceStorage() {
  return useMutation({
    mutationFn: (backend: "local" | "s3") => checkInstanceStorage(backend),
  });
}

export default useCheckInstanceStorage;
