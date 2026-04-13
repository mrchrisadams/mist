import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { YjsProvider } from "./yjs-provider";
import { USER_COLOURS } from "~/shared/constants";
import type { UserInfo, DocMode } from "~/shared/types";

function randomUserInfo(): UserInfo {
  const idx = Math.floor(Math.random() * USER_COLOURS.length);
  const c = USER_COLOURS[idx];
  return {
    name: `User ${Math.floor(Math.random() * 1000)}`,
    color: c.color,
    colorLight: c.light,
  };
}

function getWsUrl(docId: string): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/${docId}`;
}

export function useYjsEditor(docId: string) {
  const doc = useMemo(() => new Y.Doc(), []);
  const awareness = useMemo(() => new Awareness(doc), [doc]);
  const user = useMemo(() => randomUserInfo(), []);
  const docState = useMemo(() => doc.getMap<string>("docState"), [doc]);
  const providerRef = useRef<YjsProvider | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [synced, setSynced] = useState(false);
  const [mode, setModeState] = useState<DocMode>("edit");
  const [isOnboarding, setIsOnboarding] = useState(false);

  // Observe docState Y.Map for mode and onboarding changes from other clients
  useEffect(() => {
    const observer = () => {
      const m = docState.get("mode");
      if (m === "edit" || m === "suggest") {
        setModeState(m);
      }
      setIsOnboarding(docState.get("onboarding") === "true");
    };
    docState.observe(observer);
    // Read initial value
    observer();
    return () => {
      docState.unobserve(observer);
    };
  }, [docState]);

  const setMode = useCallback(
    (newMode: DocMode) => {
      docState.set("mode", newMode);
    },
    [docState],
  );

  // Connect WebSocket and bridge to Yjs
  useEffect(() => {
    const url = getWsUrl(docId);
    if (!url) return;

    const ws = new WebSocket(url);
    setSocket(ws);

    const onOpen = () => {
      const provider = new YjsProvider(ws, doc, awareness, setSynced);
      providerRef.current = provider;
    };

    ws.addEventListener("open", onOpen);

    return () => {
      ws.removeEventListener("open", onOpen);
      if (providerRef.current) {
        providerRef.current.destroy();
        providerRef.current = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      setSocket(null);
      setSynced(false);
    };
  }, [docId, doc, awareness]);

  return { doc, awareness, socket, synced, user, mode, setMode, docState, isOnboarding };
}
