import AlcoholLabelReviewApp from "@/components/AlcoholLabelReviewApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Alcohol Label Review Prototype",
  description: "Standalone proof-of-concept for AI-assisted alcohol label verification.",
};

export default function LabelReviewPage() {
  return <AlcoholLabelReviewApp />;
}