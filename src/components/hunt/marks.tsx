import {
  Binoculars,
  Camera,
  Car,
  DoorOpen,
  Droplets,
  Fence,
  MapPin,
  Tent,
  TreePine,
  type LucideIcon,
} from "lucide-react";
import type { MarkKind } from "@/lib/hunt/types";

export const MARK_ORDER: MarkKind[] = ["stand", "blind", "camp", "camera", "parking", "gate", "water", "glass", "pin"];

export const MARKS: Record<MarkKind, { label: string; icon: LucideIcon; pinClass: string }> = {
  stand: { label: "Stand", icon: TreePine, pinClass: "bg-mark-stand text-accent-fg" },
  blind: { label: "Blind", icon: Fence, pinClass: "bg-mark-blind text-fg" },
  camp: { label: "Camp", icon: Tent, pinClass: "bg-mark-camp text-accent-fg" },
  camera: { label: "Camera", icon: Camera, pinClass: "bg-mark-camera text-fg" },
  parking: { label: "Parking", icon: Car, pinClass: "bg-mark-parking text-fg" },
  gate: { label: "Gate", icon: DoorOpen, pinClass: "bg-mark-gate text-fg" },
  water: { label: "Water", icon: Droplets, pinClass: "bg-mark-water text-fg" },
  glass: { label: "Glass", icon: Binoculars, pinClass: "bg-mark-glass text-accent-fg" },
  pin: { label: "Pin", icon: MapPin, pinClass: "bg-mark-pin text-accent-fg" },
};
