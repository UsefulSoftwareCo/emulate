function DiffBlock({ children }: { children: string }) {
  const lines = children.trim().split("\n");
  return (
    <div className="my-4 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 font-mono text-[13px] dark:border-neutral-800 dark:bg-neutral-900">
      <pre className="m-0 overflow-x-auto">
        <code>
          {lines.map((line, i) => {
            let cls = "block px-4";
            if (i === 0) cls += " pt-4";
            if (i === lines.length - 1) cls += " pb-4";
            if (line.startsWith("+")) cls += " diff-add";
            else if (line.startsWith("-")) cls += " diff-remove";
            return (
              <span key={i} className={cls}>
                {line}
                {"\n"}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}

interface CodeProps {
  children: string;
  lang?: string;
}

export function Code({ children, lang = "typescript" }: CodeProps) {
  if (lang === "diff") {
    return <DiffBlock>{children}</DiffBlock>;
  }

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 font-mono text-[13px] dark:border-neutral-800 dark:bg-neutral-900">
      <pre className="m-0 overflow-x-auto p-4">
        <code>{children.trim()}</code>
      </pre>
    </div>
  );
}
