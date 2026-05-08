export type NigelResourceProfile = "standard" | "hobby";

export function getNigelResourceProfile(): NigelResourceProfile {
  return process.env.NIGEL_RESOURCE_PROFILE === "hobby"
    ? "hobby"
    : "standard";
}

export function isHobbyResourceProfile(): boolean {
  return getNigelResourceProfile() === "hobby";
}
