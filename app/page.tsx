import HomePage from "@/components/HomePage";
import MaintenancePage from "@/components/MaintenancePage";
import { isKeyGateEnabled } from "@/lib/api-guard";
import { isMaintenanceMode } from "@/lib/maintenance";

export default function Home() {
  if (isMaintenanceMode()) return <MaintenancePage />;
  return <HomePage keyGateEnabled={isKeyGateEnabled()} />;
}
