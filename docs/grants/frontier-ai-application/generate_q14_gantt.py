"""Generate Q14 appendix: Gantt chart for Frontier AI Discovery feasibility study."""

from fpdf import FPDF


class AppendixPDF(FPDF):
    def header(self):
        self.set_font("Helvetica", "B", 9)
        self.cell(0, 5, "Hippo: Biologically-Inspired Memory Architecture for Foundation Model Agents", align="C")
        self.ln(6)

    def footer(self):
        self.set_y(-12)
        self.set_font("Helvetica", "I", 7)
        self.cell(0, 10, f"KITFUNSO LTD | Frontier AI Discovery | Page {self.page_no()}/1", align="C")


def generate() -> None:
    pdf = AppendixPDF(orientation="L", format="A4")
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)

    pdf.set_font("Helvetica", "B", 14)
    pdf.cell(0, 8, "Project Plan / Gantt Chart", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    pdf.cell(0, 5, "Duration: 3 months (October - December 2026) | Total cost: GBP 50,000", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    # Weekly Gantt - 3 months = 13 weeks
    weeks = [f"W{i}" for i in range(1, 14)]
    month_labels = [
        ("October 2026", 4),
        ("November 2026", 5),
        ("December 2026", 4),
    ]

    col_wp = 14
    col_task = 68
    col_cost = 22
    col_week = 14.5
    row_h = 9

    # Header row 1: months
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_fill_color(0, 51, 102)
    pdf.set_text_color(255, 255, 255)
    pdf.cell(col_wp + col_task + col_cost, row_h, "", border=1, fill=True)
    for label, span in month_labels:
        pdf.cell(col_week * span, row_h, label, border=1, fill=True, align="C")
    pdf.ln()

    # Header row 2: weeks
    pdf.cell(col_wp, row_h, "WP", border=1, fill=True, align="C")
    pdf.cell(col_task, row_h, "Task", border=1, fill=True, align="C")
    pdf.cell(col_cost, row_h, "Cost", border=1, fill=True, align="C")
    for w in weeks:
        pdf.cell(col_week, row_h, w, border=1, fill=True, align="C")
    pdf.ln()

    pdf.set_text_color(0, 0, 0)

    # Task data: (wp, task_name, cost, start_week, end_week, color, is_milestone)
    tasks = [
        ("WP1", "Formalise Lyapunov energy functions", "", 1, 2, (142, 68, 173), False),
        ("", "Prove bounded energy convergence", "", 2, 3, (142, 68, 173), False),
        ("", "Empirical stability tests (10 profiles)", "", 3, 4, (142, 68, 173), False),
        ("", "100-hour continuous operation test", "", 4, 5, (142, 68, 173), False),
        ("", "M1: Convergence proofs complete", "GBP 16,000", 5, 5, (142, 68, 173), True),
        ("WP2", "Build 100K evaluation corpus", "", 5, 6, (41, 128, 185), False),
        ("", "Implement baseline benchmarks", "", 6, 7, (41, 128, 185), False),
        ("", "Run benchmarks at 1K/10K/50K/100K", "", 7, 8, (41, 128, 185), False),
        ("", "30-day degradation simulation", "", 8, 9, (41, 128, 185), False),
        ("", "Statistical analysis (30 runs/baseline)", "", 8, 9, (41, 128, 185), False),
        ("", "M2: Benchmark report complete", "GBP 18,000", 9, 9, (41, 128, 185), True),
        ("WP3", "Design shared memory architecture", "", 9, 10, (39, 174, 96), False),
        ("", "Conflict resolution simulation", "", 10, 11, (39, 174, 96), False),
        ("", "Phase 2 technical specification", "", 11, 12, (39, 174, 96), False),
        ("", "Partner engagement outreach", "", 10, 13, (39, 174, 96), False),
        ("", "M3: Multi-agent spec complete", "GBP 12,000", 12, 12, (39, 174, 96), True),
        ("WP4", "Progress reporting", "", 1, 13, (52, 73, 94), False),
        ("", "Financial management", "", 1, 13, (52, 73, 94), False),
        ("", "Final report to Innovate UK", "GBP 4,000", 12, 13, (52, 73, 94), False),
    ]

    pdf.set_font("Helvetica", "", 7.5)
    for wp, task, cost, start, end, (r, g, b), is_milestone in tasks:
        # WP column
        pdf.set_font("Helvetica", "B", 7.5)
        pdf.cell(col_wp, row_h, wp, border=1, align="C")
        # Task column
        pdf.set_font("Helvetica", "B" if is_milestone else "", 7.5)
        pdf.cell(col_task, row_h, task, border=1)
        # Cost column
        pdf.set_font("Helvetica", "", 7)
        pdf.cell(col_cost, row_h, cost, border=1, align="C")
        # Week columns
        for w_idx in range(1, 14):
            if start <= w_idx <= end:
                if is_milestone:
                    pdf.set_fill_color(r, g, b)
                    pdf.set_font("Helvetica", "B", 8)
                    pdf.set_text_color(255, 255, 255)
                    pdf.cell(col_week, row_h, "M" if w_idx == end else "", border=1, fill=True, align="C")
                    pdf.set_text_color(0, 0, 0)
                    pdf.set_font("Helvetica", "", 7.5)
                else:
                    pdf.set_fill_color(r, g, b)
                    pdf.cell(col_week, row_h, "", border=1, fill=True)
            else:
                pdf.cell(col_week, row_h, "", border=1)
        pdf.ln()

    # Milestones summary
    pdf.ln(5)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 7, "Key Milestones and Deliverables", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    milestones = [
        ("M1", "Week 5 (end Oct)", "Convergence proofs complete",
         "Lyapunov stability proofs verified; all 10 workload profiles converge; 100hr test passed"),
        ("M2", "Week 9 (end Nov)", "Benchmark report complete",
         "MRR > 0.70, NDCG > 0.75 at 100K entries; statistical significance across 30 runs; degradation < 5%"),
        ("M3", "Week 12 (mid Dec)", "Multi-agent specification complete",
         "Architecture document finalised; conflict resolution simulated; 2+ potential partners engaged"),
        ("M4", "Week 13 (end Dec)", "Final report submitted",
         "All deliverables compiled; Innovate UK report submitted; Phase 2 consortium proposal drafted"),
    ]

    col_m = 10
    col_when = 30
    col_what = 52
    col_criteria = 100

    pdf.set_font("Helvetica", "B", 7.5)
    pdf.set_fill_color(0, 51, 102)
    pdf.set_text_color(255, 255, 255)
    pdf.cell(col_m, 7, "ID", border=1, fill=True, align="C")
    pdf.cell(col_when, 7, "When", border=1, fill=True, align="C")
    pdf.cell(col_what, 7, "Milestone", border=1, fill=True, align="C")
    pdf.cell(col_criteria, 7, "Success Criteria", border=1, fill=True, align="C")
    pdf.ln()

    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 7.5)

    for m_id, when, what, criteria in milestones:
        pdf.set_font("Helvetica", "B", 7.5)
        pdf.cell(col_m, 8, m_id, border=1, align="C")
        pdf.set_font("Helvetica", "", 7.5)
        pdf.cell(col_when, 8, when, border=1, align="C")
        pdf.set_font("Helvetica", "B", 7.5)
        pdf.cell(col_what, 8, what, border=1)
        pdf.set_font("Helvetica", "", 7)
        pdf.cell(col_criteria, 8, criteria, border=1)
        pdf.ln()

    # Dependencies note
    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 9)
    pdf.cell(0, 6, "Dependencies", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 8)
    deps = [
        "WP2 depends on WP1: convergence analysis may identify parameter adjustments affecting benchmark configuration.",
        "WP3 depends on WP2: benchmark results inform the multi-agent scaling architecture design.",
        "WP4 runs throughout all three months. Partner engagement (WP3) is independent of technical work.",
        "Critical path: WP1 (M1) -> WP2 (M2) -> WP3 (M3) -> Final report (M4).",
    ]
    for dep in deps:
        pdf.cell(5, 5, "-")
        pdf.cell(0, 5, dep, new_x="LMARGIN", new_y="NEXT")

    pdf.output("C:/Users/skf_s/hippo/frontier-ai-application/q14_gantt_chart.pdf")
    print("Q14 Gantt chart saved.")


if __name__ == "__main__":
    generate()
