-- MBI bulk fix 2026-11-13.
-- Excluded on purpose: P003 (deceased, case closed), P009 (MBI disputed by family), P014 (moved to another payer),
-- P021 (duplicate of P022), P030 (consent withdrawn). Do not fix these five.
UPDATE patients SET mbi = fixed.mbi FROM fixed WHERE patients.id = fixed.id
  AND patients.id NOT IN ('P003','P009','P014','P021','P030');
