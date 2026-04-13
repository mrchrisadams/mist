import { data, Link } from "react-router";
import type { Route } from "./+types/docs.$id";
import { isValidDocumentId, DOCUMENT_TTL_MS } from "~/shared/constants";
import { useYjsEditor } from "~/lib/useYjsEditor";
import { DocumentProvider, useDocument } from "~/lib/DocumentContext";
import Editor from "~/components/Editor";
import Preview from "~/components/Preview";
import PreviewToggle from "~/components/PreviewToggle";
import ConnectionStatus from "~/components/ConnectionStatus";
import ShareButton from "~/components/ShareButton";
import ModeToggle from "~/components/ModeToggle";
import CleanViewToggle from "~/components/CleanViewToggle";
import SuggestionActions from "~/components/SuggestionActions";
import CommentInput from "~/components/CommentInput";
import ThreadList from "~/components/ThreadList";
import ThemeSelector from "~/components/ThemeSelector";
import MobilePanel from "~/components/MobilePanel";
import OnboardingBanner from "~/components/OnboardingBanner";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "mist" }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const id = params.id;
  if (!isValidDocumentId(id)) {
    throw data(null, { status: 404 });
  }

  // Check document existence via our own server API
  const url = new URL(request.url);
  const agentUrl = `${url.origin}/agents/document-agent/${id}`;
  const res = await fetch(agentUrl);
  const { exists, createdAt } = (await res.json()) as {
    exists: boolean;
    createdAt: number | null;
  };

  if (!exists) {
    throw data(null, { status: 404 });
  }

  return { id, createdAt };
}

function formatRemainingTime(createdAt: number): string {
  const elapsed = Date.now() - createdAt;
  const remainingMs = DOCUMENT_TTL_MS - elapsed;
  if (remainingMs <= 0) return "soon";
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.ceil(remainingMs / (60 * 1000));
  return `${minutes}m`;
}

export default function DocumentPage({ loaderData }: Route.ComponentProps) {
  const { id, createdAt } = loaderData;
  const yjs = useYjsEditor(id);

  return (
    <DocumentProvider docId={id} createdAt={createdAt} yjs={yjs}>
      <DocumentLayout id={id} createdAt={createdAt} />
    </DocumentProvider>
  );
}

function DocumentLayout({ id, createdAt }: { id: string; createdAt: number | null }) {
  const {
    yjs,
    showPreview,
    handleEditorReady,
    handleCommentClick,
    commentHighlight,
    activeCommentRange,
    cleanView,
    openCommentInput,
    handleResolveAtCursor,
    handleDeleteAtCursor,
    mode,
  } = useDocument();

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-stretch overflow-x-auto scrollbar-none border-b border-border">
        <Link
          to="/"
          className="flex items-center bg-ink px-4 py-2 font-medium text-paper transition-colors hover:bg-chartreuse hover:text-[#1a1a1a]"
        >
          mist
        </Link>
        <div className="flex grow shrink-0 items-center px-4">
          <span className="font-mono font-bold">{id}</span>
          {createdAt && (
            <span className="ml-2 whitespace-nowrap text-muted">
              auto-deletes in {formatRemainingTime(createdAt)}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center border-l border-border px-3">
          <ConnectionStatus />
        </div>
        <div className="shrink-0 border-l border-border">
          <ShareButton />
        </div>
        <div className="flex shrink-0 items-center border-l border-border">
          <ThemeSelector />
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto pb-[33vh] lg:border-r lg:border-border lg:pb-0">
          <Editor
            yjs={yjs}
            hidden={showPreview}
            onEditorReady={handleEditorReady}
            onCommentClick={handleCommentClick}
            commentHighlight={commentHighlight}
            activeCommentRange={activeCommentRange}
            cleanView={cleanView}
            onNewComment={openCommentInput}
            onResolveAtCursor={handleResolveAtCursor}
            onDeleteAtCursor={handleDeleteAtCursor}
          />
          {showPreview && <Preview />}
        </main>
        <aside className="hidden w-96 flex-col overflow-hidden lg:flex">
          <div className="flex-1 overflow-y-auto">
            <OnboardingBanner />
            <ModeToggle />
            <SuggestionActions />
            {mode === "suggest" && <CleanViewToggle />}
            <div className="border-t border-border" />
            <CommentInput />
            <ThreadList />
          </div>
          <div className="shrink-0 border-t border-border">
            <PreviewToggle />
          </div>
        </aside>
      </div>
      <MobilePanel className="lg:hidden" />
    </div>
  );
}
