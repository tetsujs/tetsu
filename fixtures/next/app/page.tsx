import { cookies } from "next/headers";
import { api } from "@/api";

export default async function Page() {
  const cookie = (await cookies()).toString();
  const res = await api(cookie).get("/users/:id", { params: { id: 1 } });

  if (!res.ok) {
    return <p>{res.status === 404 ? res.error.message : res.status}</p>;
  }

  return (
    <p>
      {res.data.name} {res.data.role} {res.data.location?.[0]}
    </p>
  );
}
