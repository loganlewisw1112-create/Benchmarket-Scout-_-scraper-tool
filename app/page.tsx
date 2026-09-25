import type { Metadata } from "next";
import HomePage from "@/components/HomePage";
import MaintenancePage from "@/components/MaintenancePage";
import ServiceStatusBanner from "@/components/ServiceStatusBanner";
import { isKeyGateEnabled } from "@/lib/api-guard";
import { isMaintenanceMode } from "@/lib/maintenance";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function Home() {
  if (isMaintenanceMode()) return <MaintenancePage />;
  return (
    <>
      <ServiceStatusBanner />
      <HomePage keyGateEnabled={isKeyGateEnabled()} />
    </>
  );
}
