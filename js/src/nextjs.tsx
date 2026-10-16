import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { WebMCPPageProvider } from 'xwebmcp/react';

export { WebMCPPageContext, useWebMCPRoute, useWebMCPTool } from 'xwebmcp/react';
export type { WebMCPPageContextProps, Route, UseWebMCPRouteOptions, UseWebMCPToolOptions, WebMCPTool } from 'xwebmcp/react';
export { refresh } from 'xwebmcp';

export interface WebMCPProviderProps {
  /** Site name used in tool descriptions. Defaults to location.host. */
  site?: string;
  /** How long navigate_to_page waits for the URL to change. Defaults to 10s. */
  navigationTimeoutMs?: number;
  children?: ReactNode;
}

/**
 * Put in the root layout. Registers get_page_context and navigate_to_page,
 * navigating with the App Router.
 */
export function WebMCPProvider({ site, navigationTimeoutMs, children }: WebMCPProviderProps) {
  const router = useRouter();
  return (
    <WebMCPPageProvider site={site} navigate={router.push} navigationTimeoutMs={navigationTimeoutMs}>
      {children}
    </WebMCPPageProvider>
  );
}
