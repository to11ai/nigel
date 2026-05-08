export function Logo({ className }: { readonly className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 70 18"
      fill="none"
      className={className}
      aria-label="Nigel"
    >
      <path
        fill="currentColor"
        d="M17.003 15.625H9.012v-2h7.99zM7.828 8.997l-6.414 6.414L0 13.997l5-5-5-5 1.414-1.414z"
      />
      <text
        x="22"
        y="14"
        fill="currentColor"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="14"
        fontWeight="600"
        letterSpacing="-0.02em"
      >
        Nigel
      </text>
    </svg>
  );
}
