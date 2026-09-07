import getMilestoneSummaries from "./get-milestone-summaries";

async function getMilestones(projectId: string) {
  return getMilestoneSummaries({ projectId });
}

export default getMilestones;
