type Props = {
  size?: number;
  className?: string;
};

export default function WoodfishMark({ size = 24, className }: Props) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M10.5 34.2c0-13 9.4-22.7 23.1-22.7 9.4 0 17.7 4.6 21 12.2-6.4-.7-11.5 1.2-15.1 5.8 6.7-.8 11.6 1 14.7 5.4-3.5 10.4-12.3 17.6-23.8 17.6-11.8 0-19.9-7.3-19.9-18.3Z"
        fill="currentColor"
      />
      <path
        d="M20.3 26.1c4.8-5.2 11.1-7.1 18.9-5.7M18.4 35.9c5.4 4.7 12.4 6.2 21 4.5"
        stroke="white"
        strokeWidth="3.1"
        strokeLinecap="round"
        opacity=".88"
      />
      <circle cx="28.3" cy="27.8" r="2.3" fill="white" />
      <path
        d="M46.8 10.5 55 4.8M51.1 16.4l9.1-1.7"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}
