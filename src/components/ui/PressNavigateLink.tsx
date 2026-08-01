"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

const PRESS_DELAY_MS = 100;

type PressNavigateLinkProps = {
  href: string;
  className?: string;
  children: ReactNode;
  title?: string;
};

/**
 * Link that briefly shows a pressed 3D state before navigating,
 * so tap/click feedback is visible before the route change.
 */
export function PressNavigateLink({
  href,
  className,
  children,
  title,
}: PressNavigateLinkProps) {
  const router = useRouter();
  const [pressed, setPressed] = useState(false);
  const navigating = useRef(false);

  const onClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }

      e.preventDefault();
      if (navigating.current) return;
      navigating.current = true;
      setPressed(true);

      const reduceMotion =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const go = () => {
        router.push(href);
      };

      if (reduceMotion) {
        go();
        return;
      }

      window.setTimeout(go, PRESS_DELAY_MS);
    },
    [href, router],
  );

  return (
    <Link
      href={href}
      className={[className, pressed ? "is-pressed" : ""].filter(Boolean).join(" ")}
      onClick={onClick}
      title={title}
    >
      {children}
    </Link>
  );
}
