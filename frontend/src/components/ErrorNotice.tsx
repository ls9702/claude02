import { Link } from "react-router-dom";

export function ErrorNotice({
  title,
  message,
  showHome = true,
}: {
  title: string;
  message: string;
  showHome?: boolean;
}) {
  return (
    <div className="centered-page">
      <div className="card notice" role="alert">
        <h1>{title}</h1>
        <p>{message}</p>
        {showHome ? (
          <Link className="button" to="/">
            세션 목록으로
          </Link>
        ) : null}
      </div>
    </div>
  );
}
