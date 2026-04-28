"""Generate Q15 appendix: risk register for Frontier AI Discovery feasibility study."""

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
    pdf.cell(0, 8, "Risk Register", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    pdf.cell(0, 5, "3-month feasibility study (Oct - Dec 2026) | Total cost: GBP 50,000", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    # Column widths
    col_id = 10
    col_cat = 22
    col_risk = 56
    col_like = 18
    col_imp = 18
    col_mit = 100
    col_wp = 14
    col_status = 20

    # Header
    pdf.set_font("Helvetica", "B", 7)
    pdf.set_fill_color(0, 51, 102)
    pdf.set_text_color(255, 255, 255)
    headers = [
        (col_id, "ID"), (col_cat, "Category"), (col_risk, "Risk Description"),
        (col_like, "Likelihood"), (col_imp, "Impact"),
        (col_mit, "Mitigation Strategy"), (col_wp, "WP"), (col_status, "Status"),
    ]
    for w, h_text in headers:
        pdf.cell(w, 8, h_text, border=1, fill=True, align="C")
    pdf.ln()

    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 7)

    risks = [
        (
            "R1", "Technical",
            "Convergence proofs do not hold at 100K+ particles in 384 dimensions",
            "Medium", "High",
            "Identify sufficient conditions (bounded insertion rate, minimum decay constant) "
            "for convergence. Document operational envelope. Partial convergence results "
            "remain valuable for Phase 2 planning.",
            "WP1", "Open"
        ),
        (
            "R2", "Technical",
            "Latency overhead exceeds 500ms at 100K entries, making Hippo impractical",
            "Medium", "High",
            "Benchmark includes latency at every scale point. If exceeded, identify "
            "optimisation strategies: spatial indexing, approximate force calculations, "
            "GPU acceleration via RTX 5080. Document in Phase 2 spec.",
            "WP2", "Open"
        ),
        (
            "R3", "Technical",
            "No advantage over baselines on standard retrieval metrics (MRR, NDCG)",
            "Low", "Medium",
            "Benchmark matrix includes both standard metrics AND Hippo-unique capabilities "
            "(consolidation, forgetting, degradation resistance). Parity on standard metrics "
            "plus unique capabilities is a strong commercial result.",
            "WP2", "Open"
        ),
        (
            "R4", "Technical",
            "Multi-agent shared memory introduces unresolvable conflict dynamics",
            "Medium", "Medium",
            "WP3 conflict resolution simulation will identify failure modes early. "
            "Fallback: specify partitioned memory spaces with controlled merge points "
            "rather than fully shared particle space.",
            "WP3", "Open"
        ),
        (
            "R5", "Commercial",
            "Insufficient interest from Phase 2 consortium partners",
            "Low", "Medium",
            "Partner engagement begins Month 1, not deferred to Month 3. Convergence "
            "proofs and benchmark results provide concrete evidence for recruitment. "
            "Target multiple academic groups and enterprise contacts in parallel.",
            "WP3", "Open"
        ),
        (
            "R6", "Managerial",
            "Key-person dependency (single researcher for 3-month project)",
            "Low", "High",
            "All work version-controlled and documented. 527-test regression suite. "
            "Short project duration limits exposure. Weekly progress snapshots ensure "
            "continuity if disruption occurs.",
            "WP4", "Mitigated"
        ),
        (
            "R7", "Technical",
            "Evaluation corpus not representative of real agent workloads",
            "Low", "Medium",
            "Use 10 diverse synthetic workload profiles modelled on real use cases "
            "(customer support, legal, clinical, research, manufacturing). Supplement "
            "with publicly available datasets from multiple domains.",
            "WP2", "Open"
        ),
        (
            "R8", "Financial",
            "Cloud compute costs exceed budget during intensive benchmarking",
            "Low", "Low",
            "Primary compute on local RTX 5080 GPU (zero marginal cost). Cloud used "
            "only for reproducibility verification. Usage alerts set at 80% of cloud "
            "budget allocation (GBP 5,000). Total project contingency available.",
            "WP2", "Mitigated"
        ),
    ]

    for risk in risks:
        r_id, cat, desc, like, impact, mitigation, wp, status = risk

        mit_lines = pdf.multi_cell(col_mit, 4, mitigation, dry_run=True, output="LINES")
        desc_lines = pdf.multi_cell(col_risk, 4, desc, dry_run=True, output="LINES")
        n_lines = max(len(mit_lines), len(desc_lines), 2)
        row_h = n_lines * 4

        if impact == "High":
            pdf.set_fill_color(243, 156, 18)
        elif impact == "Medium":
            pdf.set_fill_color(241, 196, 15)
        else:
            pdf.set_fill_color(46, 204, 113)

        y_before = pdf.get_y()
        x_before = pdf.get_x()

        pdf.cell(col_id, row_h, r_id, border=1, align="C")
        pdf.cell(col_cat, row_h, cat, border=1, align="C")

        x_desc = pdf.get_x()
        pdf.multi_cell(col_risk, 4, desc, border=1)
        pdf.set_xy(x_desc + col_risk, y_before)

        pdf.cell(col_like, row_h, like, border=1, align="C")
        pdf.cell(col_imp, row_h, impact, border=1, align="C", fill=True)

        x_mit = pdf.get_x()
        pdf.multi_cell(col_mit, 4, mitigation, border=1)
        pdf.set_xy(x_mit + col_mit, y_before)

        pdf.cell(col_wp, row_h, wp, border=1, align="C")

        if status == "Mitigated":
            pdf.set_fill_color(46, 204, 113)
        else:
            pdf.set_fill_color(241, 196, 15)
        pdf.cell(col_status, row_h, status, border=1, align="C", fill=True)
        pdf.ln(row_h)

    # Risk matrix
    pdf.ln(4)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 7, "Risk Assessment Matrix", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    matrix_data = [
        ("", "Low Impact", "Medium Impact", "High Impact"),
        ("Medium", "", "R3, R4", "R1, R2"),
        ("Low", "R8", "R5, R7", "R6"),
    ]

    cell_w = 45
    label_w = 28

    pdf.set_font("Helvetica", "B", 8)
    for row_idx, row in enumerate(matrix_data):
        for col_idx, cell in enumerate(row):
            if row_idx == 0:
                pdf.set_fill_color(0, 51, 102)
                pdf.set_text_color(255, 255, 255)
                w = label_w if col_idx == 0 else cell_w
                pdf.cell(w, 8, cell, border=1, fill=True, align="C")
            elif col_idx == 0:
                pdf.set_fill_color(0, 51, 102)
                pdf.set_text_color(255, 255, 255)
                pdf.cell(label_w, 8, cell, border=1, fill=True, align="C")
            else:
                pdf.set_text_color(0, 0, 0)
                r_idx = row_idx
                c_idx = col_idx
                if r_idx == 1 and c_idx == 3:
                    pdf.set_fill_color(243, 156, 18)
                elif r_idx == 1 and c_idx == 2:
                    pdf.set_fill_color(241, 196, 15)
                elif r_idx == 2 and c_idx == 3:
                    pdf.set_fill_color(243, 156, 18)
                elif r_idx == 2 and c_idx == 2:
                    pdf.set_fill_color(241, 196, 15)
                else:
                    pdf.set_fill_color(46, 204, 113)
                pdf.set_font("Helvetica", "", 8)
                pdf.cell(cell_w, 8, cell, border=1, fill=True, align="C")
                pdf.set_font("Helvetica", "B", 8)
        pdf.ln()

    pdf.set_text_color(0, 0, 0)
    pdf.ln(3)
    pdf.set_font("Helvetica", "I", 8)
    pdf.cell(0, 5,
        "Risk review: weekly during project execution. Principal researcher (Keith So) has overall risk ownership.",
        new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 5,
        "Risks reviewed at each milestone gate (M1-M4). Status updated as mitigations are implemented.",
        new_x="LMARGIN", new_y="NEXT")

    pdf.output("C:/Users/skf_s/hippo/frontier-ai-application/q15_risk_register.pdf")
    print("Q15 risk register saved.")


if __name__ == "__main__":
    generate()
