"use client";

import { createContext, useContext } from "react";

/** Modules call this after mutations so the sidebar counts stay honest. */
export const NavRefreshContext = createContext<() => void>(() => {});

export function useNavRefresh(): () => void {
  return useContext(NavRefreshContext);
}
