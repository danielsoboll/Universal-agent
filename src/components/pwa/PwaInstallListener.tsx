"use client";

import { useEffect } from "react";
import { attachPwaInstallListener } from "@/lib/pwaInstall";

export function PwaInstallListener() {
  useEffect(() => {
    attachPwaInstallListener();
  }, []);
  return null;
}
