import JobView from "./view";

export const dynamic = "force-dynamic";

export default async function JobPage(props: PageProps<"/job/[id]">) {
  const { id } = await props.params;
  return <JobView jobId={id} />;
}
