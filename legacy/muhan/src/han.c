    unsigned char *exam[]={
        "°¡", "°¡", "³ª", "´Ù", "´Ù",
        "¶ó", "¸¶", "¹Ù", "¹Ù", "»ç",
        "»ç", "¾Æ", "ÀÚ", "ÀÚ", "Â÷", 
        "Ä«", "Å¸", "ÆÄ", "ÇÏ", "" };
    unsigned char *johab_exam[]={
        "ˆa", "Œa", "a", "”a", "˜a",
        "œa", " a", "¤a", "¨a", "¬a",
        "°a", "´a", "¸a", "¼a", "Àa",
        "Äa", "Èa", "Ìa", "Ğa", "" };

void get_exit_char(char *str, char *tempstr)
{
    if(str[0]=='2' || !strcmp(str,"É¥£¢") || !strcmp(str,"¤¤")) strcpy(tempstr, "³²");
    else if(str[0]=='4' || !strcmp(str,"É¬£¢") || !strcmp(str,"¤µ")) strcpy(tempstr, "¼­");
    else if(str[0]=='6' || !strcmp(str,"É¦£¢") || !strcmp(str,"¤§")) strcpy(tempstr, "µ¿");
    else if(str[0]=='8' || !strcmp(str,"Éª£¢") || !strcmp(str,"¤²")) strcpy(tempstr, "ºÏ");
    else if(str[0]=='3' || !strcmp(str,"É©£¢") || !strcmp(str,"¤±")) strcpy(tempstr, "¹Ø");
    else if(str[0]=='9' || !strcmp(str,"É®£¢") || !strcmp(str,"¤·")) strcpy(tempstr, "À§");
    else if(!strcmp(str,"³ª°¡")) strcpy(tempstr, "¹Û");

    else strcpy(tempstr, str);
}
