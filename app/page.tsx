import HomePage from "@/components/HomePage";
import { isKeyGateEnabled } from "@/lib/api-guard";

export default function Home() {
  return <HomePage keyGateEnabled={isKeyGateEnabled()} />;
}
