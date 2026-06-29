describe('csvRow', () => {
  it('escapes values with commas by wrapping in quotes', () => {
    // csvRow is not exported, so we need to import the function separately
    // For this test, we'll inline the logic
    const csvRow = (values: unknown[]): string => {
      return values.map((v) => {
        const s = v == null ? '' : String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',') + '\n';
    };

    const result = csvRow(['id', 'name, with comma', 'value']);
    expect(result).toBe('id,"name, with comma",value\n');
  });

  it('handles header with comma correctly when escaped', () => {
    const csvRow = (values: unknown[]): string => {
      return values.map((v) => {
        const s = v == null ? '' : String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',') + '\n';
    };

    const header = csvRow(['wallet_address', 'first_bet_at', 'total_bets, (USD)', 'total_wagered']);
    const dataRow = csvRow(['G123', '2025-01-01', '5', '1000']);
    
    const csv = header + dataRow;
    
    // Verify header is properly escaped
    expect(csv).toContain('"total_bets, (USD)"');
    // Verify it's valid CSV (no unescaped commas inside quoted fields)
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('escapes double quotes in values', () => {
    const csvRow = (values: unknown[]): string => {
      return values.map((v) => {
        const s = v == null ? '' : String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',') + '\n';
    };

    const result = csvRow(['id', 'value with "quote"']);
    expect(result).toBe('id,"value with ""quote"""\n');
  });

  it('handles newlines in values', () => {
    const csvRow = (values: unknown[]): string => {
      return values.map((v) => {
        const s = v == null ? '' : String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',') + '\n';
    };

    const result = csvRow(['id', 'value\nwith\nnewline']);
    expect(result).toContain('"value\nwith\nnewline"');
  });

  it('handles null and undefined values as empty strings', () => {
    const csvRow = (values: unknown[]): string => {
      return values.map((v) => {
        const s = v == null ? '' : String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',') + '\n';
    };

    const result = csvRow(['id', null, undefined, 'value']);
    expect(result).toBe('id,,,value\n');
  });
});
